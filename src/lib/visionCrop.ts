import { getAuthToken } from './insforge';

// Client for the serverless vision endpoint (api/vision/smart-crop). Downscales
// the flyer to a small JPEG (cheap + fast tokens), asks Claude vision for the
// focal point of the most important content, and returns it normalised 0..1.
// Everything here is best-effort: any failure/timeout resolves to null so the
// caller falls back to the instant on-device heuristic.

export type VisionFocus = {
  focus: { x: number; y: number };
  keep: { x: number; y: number; w: number; h: number } | null;
  hasFaces: boolean;
  primary: string | null;
};

type Bitmap = CanvasImageSource & { width: number; height: number };

function toBase64Jpeg(bitmap: Bitmap, maxDim = 512): { data: string; mime: string } | null {
  try {
    const w = bitmap.width, h = bitmap.height;
    if (!w || !h) return null;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    const url = c.toDataURL('image/jpeg', 0.82);
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    return { data: url.slice(comma + 1), mime: 'image/jpeg' };
  } catch { return null; }
}

export async function fetchVisionFocus(bitmap: Bitmap, timeoutMs = 13000): Promise<VisionFocus | null> {
  const img = toBase64Jpeg(bitmap);
  if (!img) return null;
  try {
    const token = await getAuthToken().catch(() => '');
    if (!token) return null;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('/api/vision/smart-crop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ imageBase64: img.data, mimeType: img.mime }),
      signal: ctrl.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.ok || !d.focus) return null;
    return { focus: d.focus, keep: d.keep ?? null, hasFaces: !!d.hasFaces, primary: d.primary ?? null };
  } catch { return null; }
}
