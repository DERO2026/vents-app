import { withTimeoutFallback } from './withTimeoutFallback';

export interface CompressedImage {
  blob: Blob;
  mimeType: string;
  extension: string;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function rawFallback(blob: Blob): CompressedImage {
  return { blob, mimeType: blob.type || 'image/jpeg', extension: 'jpg' };
}

/**
 * Resizes and re-encodes an image, preferring WebP for smaller CDN-delivered
 * payloads. Falls back to JPEG on browsers where canvas WebP encoding isn't
 * supported (canvas.toBlob returns null, or silently produces a PNG).
 *
 * HTML5 Canvas work (image decode, drawImage, toBlob) has been observed to
 * freeze or silently fail to fire its callback on mobile browsers — most
 * notably iOS Safari — which used to hang this promise forever and trap
 * users on screens gated behind it (e.g. "Next: Venue"). This function
 * therefore NEVER rejects: a 3-second safety timeout (via the shared
 * withTimeoutFallback utility) AND a try/catch around the whole operation
 * both resolve to the original, uncompressed file instead of hanging or
 * failing the caller.
 */
export async function compressImage(blob: Blob, maxPx = 1200, quality = 0.8): Promise<CompressedImage> {
  try {
    return await withTimeoutFallback(compressImageInner(blob, maxPx, quality), {
      timeoutMs: 3000,
      fallback: () => {
        console.warn('[VENTS] compressImage: canvas compression exceeded 3s — using original file');
        return rawFallback(blob);
      },
    });
  } catch (err) {
    // Any non-timeout failure (canvas 2D context unavailable, toBlob
    // throwing, a decode error slipping past img.onerror, etc.) must never
    // hang or fail the upload — always fall back to the original file.
    console.warn('[VENTS] compressImage: canvas compression failed — using original file', err);
    return rawFallback(blob);
  }
}

async function compressImageInner(blob: Blob, maxPx: number, quality: number): Promise<CompressedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = async () => {
      URL.revokeObjectURL(url);
      try {
        let { width, height } = img;
        if (width > maxPx || height > maxPx) {
          if (width >= height) { height = Math.round((height / width) * maxPx); width = maxPx; }
          else { width = Math.round((width / height) * maxPx); height = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        ctx.drawImage(img, 0, 0, width, height);

        const webpBlob = await canvasToBlob(canvas, 'image/webp', quality);
        if (webpBlob && webpBlob.type === 'image/webp') {
          resolve({ blob: webpBlob, mimeType: 'image/webp', extension: 'webp' });
          return;
        }

        const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', quality);
        resolve({ blob: jpegBlob || blob, mimeType: 'image/jpeg', extension: 'jpg' });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      console.warn('[VENTS] compressImage: image failed to decode — using original file');
      resolve({ blob, mimeType: blob.type || 'image/jpeg', extension: 'jpg' });
    };
    img.src = url;
  });
}
