// ── Scanner module (QR decoding) ─────────────────────────────────────────────
// Runs a throttled decode loop against a caller-owned <video>. Uses the native
// BarcodeDetector fast path where present (Chrome / Android WebView) and falls
// back to jsQR everywhere else (notably iOS Safari / WKWebView, which does not
// ship BarcodeDetector). Decodes a centered, downscaled crop of each frame for
// speed and to match the on-screen scan window. Emits raw decoded strings; the
// caller owns validation, de-duplication policy, and pause/resume — this module
// only turns pixels into text while `enabled` is true.

import { useEffect, useRef } from 'react';
import jsQR from 'jsqr';

interface UseQrScannerOpts {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  enabled: boolean;              // false while a result is being processed/shown
  onDecode: (text: string) => void;
  /** Decode attempt cadence. ~10/s is plenty for QR and easy on the battery. */
  intervalMs?: number;
  /** Downscaled square sample size fed to the decoder (px). */
  sampleSize?: number;
}

// Feature-detect BarcodeDetector once. Undefined until first checked.
let barcodeDetectorSupported: boolean | null = null;
async function makeBarcodeDetector(): Promise<any | null> {
  try {
    const BD = (window as any).BarcodeDetector;
    if (!BD) { barcodeDetectorSupported = false; return null; }
    if (barcodeDetectorSupported === false) return null;
    const formats = await BD.getSupportedFormats?.();
    if (formats && !formats.includes('qr_code')) { barcodeDetectorSupported = false; return null; }
    barcodeDetectorSupported = true;
    return new BD({ formats: ['qr_code'] });
  } catch {
    barcodeDetectorSupported = false;
    return null;
  }
}

export function useQrScanner({
  videoRef,
  enabled,
  onDecode,
  intervalMs = 100,
  sampleSize = 500,
}: UseQrScannerOpts) {
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let stopped = false;
    let rafBusy = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    let detector: any = null;
    let detectorReady = false;

    makeBarcodeDetector().then((d) => { detector = d; detectorReady = true; });

    const tick = async () => {
      if (stopped || rafBusy) return;
      const video = videoRef.current;
      if (!enabledRef.current || !video || video.readyState < 2 || video.videoWidth === 0) return;
      rafBusy = true;
      try {
        // Center-crop the largest square from the frame, downscaled to
        // sampleSize — keeps decoding cheap and aligned with the visible window.
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        if (!ctx) return;
        ctx.drawImage(video, sx, sy, side, side, 0, 0, sampleSize, sampleSize);

        // Fast path: native BarcodeDetector.
        if (detectorReady && detector) {
          try {
            const codes = await detector.detect(canvas);
            if (!stopped && codes && codes.length > 0) {
              const val = codes[0].rawValue;
              if (val && enabledRef.current) onDecodeRef.current(val);
            }
            return;
          } catch {
            // Detector can throw transiently; fall through to jsQR this frame.
          }
        }

        // Universal path: jsQR over the sampled ImageData.
        const img = ctx.getImageData(0, 0, sampleSize, sampleSize);
        const result = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (!stopped && result && result.data && enabledRef.current) {
          onDecodeRef.current(result.data);
        }
      } catch {
        /* transient frame error — ignore, next tick retries */
      } finally {
        rafBusy = false;
      }
    };

    const id = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // Loop reads live state via refs, so it is created ONCE and never restarts
    // on enabled/onDecode changes — no re-subscription churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, intervalMs, sampleSize]);
}
