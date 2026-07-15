import { insforge, getAuthToken } from './insforge';
import { compressImage, CompressedImage } from './compressImage';
import { withTimeoutFallback } from './withTimeoutFallback';

// ─── Production media pipeline ────────────────────────────────────────────────
// Binary data is NEVER written to Postgres. Every asset is uploaded directly to
// the S3-compatible InsForge Storage bucket with a JWT-signed request (Storage
// RLS authorizes the write); only the METADATA (urls, thumbnail, dimensions,
// size, mime, owner, event) is recorded in public.media_assets.
//
// For images the pipeline: (1) compresses the full image to save bandwidth,
// (2) generates a responsive thumbnail, (3) uploads both, (4) records metadata.
// For videos: uploads the raw file, extracts a poster thumbnail from a frame,
// and records metadata.

export interface MediaAsset {
  id?: string;
  url: string;
  storageKey: string | null;
  thumbnailUrl: string | null;
  thumbnailKey: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  mimeType: string | null;
}

export interface UploadOptions {
  bucket: string;
  userId?: string | null;
  eventId?: string | null;
  filenameBase?: string;
}

function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ width: 0, height: 0 }); };
    img.src = url;
  });
}

// Signed, direct-to-object-storage upload (the request is authorized by the
// user's JWT; InsForge writes the object to the S3-compatible bucket). Wrapped
// in the failsafe so a stalled mobile connection can never hang the caller.
async function uploadBlob(bucket: string, blob: Blob, filename: string, mimeType: string): Promise<{ url: string; key: string | null }> {
  const token = await getAuthToken();
  const fd = new FormData();
  fd.append('file', new File([blob], filename, { type: mimeType }));
  const res = await withTimeoutFallback(
    fetch(`${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/${bucket}/objects`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    }),
    { timeoutMs: 12000, timeoutMessage: 'Upload is taking too long. Please check your connection and try again.' }
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Session expired. Please sign out and back in.');
    throw new Error(`Upload failed (${res.status}). Please try again.`);
  }
  const data = await res.json();
  const key: string | null = data?.key ?? null;
  const url: string | null = data?.url ?? (key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/${bucket}/objects/${encodeURIComponent(key)}` : null);
  if (!url) throw new Error('Upload succeeded but no URL was returned. Please try again.');
  return { url, key };
}

// Metadata write is best-effort: the media is already durably uploaded and
// usable via its URL, so a metadata hiccup must never fail the whole upload.
async function recordMetadata(a: MediaAsset, userId?: string | null, eventId?: string | null): Promise<void> {
  try {
    const { data } = await insforge.database.from('media_assets').insert([{
      url: a.url,
      storage_key: a.storageKey,
      thumbnail_url: a.thumbnailUrl,
      thumbnail_key: a.thumbnailKey,
      width: a.width,
      height: a.height,
      file_size: a.fileSize,
      mime_type: a.mimeType,
      user_id: userId ?? null,
      event_id: eventId ?? null,
    }]).select('id').single();
    if ((data as any)?.id) a.id = (data as any).id;
  } catch { /* upload already succeeded — metadata is non-blocking */ }
}

/** Compress → responsive thumbnail → direct signed upload of both → record metadata. */
export async function uploadImage(blob: Blob, opts: UploadOptions): Promise<MediaAsset> {
  const base = `${opts.filenameBase || 'img'}-${Date.now()}`;
  // Compress the full image (bandwidth) and build a responsive thumbnail.
  const full: CompressedImage = await compressImage(blob, 1600, 0.82);
  const thumb: CompressedImage = await compressImage(blob, 400, 0.6);
  const dims = await imageDimensions(full.blob);

  const [fullUp, thumbUp] = await Promise.all([
    uploadBlob(opts.bucket, full.blob, `${base}.${full.extension}`, full.mimeType),
    uploadBlob(opts.bucket, thumb.blob, `${base}-thumb.${thumb.extension}`, thumb.mimeType),
  ]);

  const asset: MediaAsset = {
    url: fullUp.url,
    storageKey: fullUp.key,
    thumbnailUrl: thumbUp.url,
    thumbnailKey: thumbUp.key,
    width: dims.width || null,
    height: dims.height || null,
    fileSize: full.blob.size,
    mimeType: full.mimeType,
  };
  await recordMetadata(asset, opts.userId, opts.eventId);
  return asset;
}

function videoPosterAndDims(file: Blob): Promise<{ poster: Blob | null; width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; (v as any).playsInline = true; v.src = url;
    const finish = (poster: Blob | null, w: number, h: number) => { URL.revokeObjectURL(url); resolve({ poster, width: w, height: h }); };
    v.onloadeddata = () => {
      const w = v.videoWidth, h = v.videoHeight;
      try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); }
      catch { finish(null, w, h); return; }
      v.onseeked = () => {
        try {
          const scale = Math.min(1, 400 / Math.max(w, h || 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) { finish(null, w, h); return; }
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((b) => finish(b, w, h), 'image/jpeg', 0.6);
        } catch { finish(null, w, h); }
      };
    };
    v.onerror = () => finish(null, 0, 0);
  });
}

/** Direct signed upload of a raw video + an extracted poster thumbnail → metadata. */
export async function uploadVideo(file: File, opts: UploadOptions): Promise<MediaAsset> {
  const base = `${opts.filenameBase || 'vid'}-${Date.now()}`;
  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const { poster, width, height } = await videoPosterAndDims(file);

  const uploads = [uploadBlob(opts.bucket, file, `${base}.${ext}`, file.type || 'video/mp4')];
  if (poster) uploads.push(uploadBlob(opts.bucket, poster, `${base}-poster.jpg`, 'image/jpeg'));
  const results = await Promise.all(uploads);

  const asset: MediaAsset = {
    url: results[0].url,
    storageKey: results[0].key,
    thumbnailUrl: poster ? results[1].url : null,
    thumbnailKey: poster ? results[1].key : null,
    width: width || null,
    height: height || null,
    fileSize: file.size,
    mimeType: file.type || 'video/mp4',
  };
  await recordMetadata(asset, opts.userId, opts.eventId);
  return asset;
}
