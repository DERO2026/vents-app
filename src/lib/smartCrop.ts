// Content-aware "smart" initial crop — no ML, works on every platform.
//
// When a flyer isn't already portrait, we must decide WHICH part to keep. This
// analyses the image's visual "energy" (local contrast / edges — where faces,
// text, logos and artwork live, vs. flat background) and positions the portrait
// crop window over the busiest region, so most uploads look right with zero
// manual adjustment. The organizer can still drag to override; react-easy-crop
// treats this only as the INITIAL crop.
//
// Returns a crop rectangle in PERCENTAGES (0–100) of the source, matching
// react-easy-crop's `initialCroppedAreaPercentages`. Returns a centered crop if
// analysis isn't possible.

export type AreaPct = { x: number; y: number; width: number; height: number };

type Bitmap = CanvasImageSource & { width: number; height: number };

function centeredCrop(imgW: number, imgH: number, aspect: number): AreaPct {
  const imgAspect = imgW / imgH;
  let cw: number, ch: number;
  if (imgAspect > aspect) { ch = imgH; cw = imgH * aspect; } // wider → limit width
  else { cw = imgW; ch = imgW / aspect; }                    // taller → limit height
  const x = (imgW - cw) / 2, y = (imgH - ch) / 2;
  return { x: (x / imgW) * 100, y: (y / imgH) * 100, width: (cw / imgW) * 100, height: (ch / imgH) * 100 };
}

export function computeSmartCrop(bitmap: Bitmap, aspect: number): AreaPct {
  const imgW = bitmap.width, imgH = bitmap.height;
  if (!imgW || !imgH) return centeredCrop(imgW || 1, imgH || 1, aspect);

  const imgAspect = imgW / imgH;
  // Near-target aspect → nothing meaningful to slide; keep it centered.
  if (Math.abs(imgAspect - aspect) < 0.04) return centeredCrop(imgW, imgH, aspect);

  try {
    const SW = 140;
    const scale = SW / imgW;
    const SH = Math.max(1, Math.round(imgH * scale));
    const c = document.createElement('canvas');
    c.width = SW; c.height = SH;
    const ctx = c.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!ctx) return centeredCrop(imgW, imgH, aspect);
    ctx.drawImage(bitmap, 0, 0, SW, SH);
    const { data } = ctx.getImageData(0, 0, SW, SH);

    // Luma
    const luma = new Float32Array(SW * SH);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    // Gradient energy accumulated per column and per row.
    const colE = new Float32Array(SW);
    const rowE = new Float32Array(SH);
    for (let y = 1; y < SH - 1; y++) {
      for (let x = 1; x < SW - 1; x++) {
        const i = y * SW + x;
        const gx = Math.abs(luma[i + 1] - luma[i - 1]);
        const gy = Math.abs(luma[i + SW] - luma[i - SW]);
        const g = gx + gy;
        colE[x] += g; rowE[y] += g;
      }
    }

    if (imgAspect > aspect) {
      // Landscape → choose horizontal window (full height) maximizing energy.
      const cwSmall = SH * aspect;          // crop width at small scale
      const win = Math.min(SW, Math.max(1, Math.round(cwSmall)));
      // Prefix sums over columns.
      const pre = new Float32Array(SW + 1);
      for (let x = 0; x < SW; x++) pre[x + 1] = pre[x] + colE[x];
      let bestX = 0, best = -1;
      for (let x = 0; x + win <= SW; x++) {
        const sum = pre[x + win] - pre[x];
        if (sum > best) { best = sum; bestX = x; }
      }
      const cw = imgH * aspect;
      const x = (bestX / scale);
      const xClamped = Math.max(0, Math.min(imgW - cw, x));
      return { x: (xClamped / imgW) * 100, y: 0, width: (cw / imgW) * 100, height: 100 };
    } else {
      // Tall → choose vertical window (full width) maximizing energy.
      const chSmall = SW / aspect;
      const win = Math.min(SH, Math.max(1, Math.round(chSmall)));
      const pre = new Float32Array(SH + 1);
      for (let y = 0; y < SH; y++) pre[y + 1] = pre[y] + rowE[y];
      let bestY = 0, best = -1;
      for (let y = 0; y + win <= SH; y++) {
        const sum = pre[y + win] - pre[y];
        if (sum > best) { best = sum; bestY = y; }
      }
      const ch = imgW / aspect;
      const y = (bestY / scale);
      const yClamped = Math.max(0, Math.min(imgH - ch, y));
      return { x: 0, y: (yClamped / imgH) * 100, width: 100, height: (ch / imgH) * 100 };
    }
  } catch {
    return centeredCrop(imgW, imgH, aspect);
  }
}
