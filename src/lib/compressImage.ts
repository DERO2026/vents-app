export interface CompressedImage {
  blob: Blob;
  mimeType: string;
  extension: string;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Resizes and re-encodes an image, preferring WebP for smaller CDN-delivered
 * payloads. Falls back to JPEG on browsers where canvas WebP encoding isn't
 * supported (canvas.toBlob returns null, or silently produces a PNG).
 */
export async function compressImage(blob: Blob, maxPx = 1200, quality = 0.8): Promise<CompressedImage> {
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
      resolve({ blob, mimeType: blob.type || 'image/jpeg', extension: 'jpg' });
    };
    img.src = url;
  });
}
