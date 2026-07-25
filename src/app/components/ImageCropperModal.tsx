import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Cropper from 'react-easy-crop';
import { X, Check, Crop as CropIcon, RotateCcw, Sparkles } from 'lucide-react';
import { EVENT_CARD_ASPECT, EVENT_CARD_ASPECT_CSS } from '../../lib/eventCardAspect';
import { computeSmartCropCached, cropFromFocus, type AreaPct } from '../../lib/smartCrop';
import { fetchVisionFocus, type VisionFocus } from '../../lib/visionCrop';

interface ImageCropperModalProps {
  imageSrc: string;
  onCropComplete: (croppedBlob: Blob) => void;
  onClose: () => void;
  aspect?: number;
  cropShape?: 'round' | 'rect';
  title?: string;
  /** 'avatar' keeps the compact circular cropper; 'flyer' is the premium,
   *  Apple-Photos-style event-flyer experience (portrait master, safe area,
   *  multi-context live preview, dynamic zoom-out, guidance). */
  variant?: 'avatar' | 'flyer';
}

type Bitmap = CanvasImageSource & { width: number; height: number };
type PixelCrop = { x: number; y: number; width: number; height: number };

// Master portrait flyer target. 4:5 → 1080×1350. Exports are capped at this and
// never upscale a smaller source (see renderMaster).
const MASTER_W = 1080;

// Mobile camera photos routinely carry EXIF orientation metadata. Decoding via
// createImageBitmap with imageOrientation:'from-image' bakes that rotation into
// the pixels before we draw, avoiding the "sideways crop" bug. Falls back to a
// plain <img> if the browser lacks createImageBitmap/the orientation option.
async function decodeImage(imageSrc: string): Promise<Bitmap> {
  try {
    const blob = await fetch(imageSrc).then((r) => r.blob());
    return (await createImageBitmap(blob, { imageOrientation: 'from-image' })) as Bitmap;
  } catch {
    const image = new Image();
    image.src = imageSrc;
    image.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    return image as Bitmap;
  }
}

// Canvas blur (ctx.filter) isn't supported on every WebView; detect once.
let _blurSupport: boolean | null = null;
function supportsCanvasBlur(): boolean {
  if (_blurSupport !== null) return _blurSupport;
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return (_blurSupport = false);
    ctx.filter = 'blur(2px)';
    return (_blurSupport = ctx.filter === 'blur(2px)');
  } catch { return (_blurSupport = false); }
}

// Draw the portrait master: a filled background (blurred cover of the flyer, so
// landscape/square uploads "adapt into portrait" with no empty bars) plus the
// user's positioned/zoomed flyer on top. `cropped` is react-easy-crop's crop in
// SOURCE pixels — when the user zooms out to see the whole flyer it extends past
// the image bounds, and the background shows through there.
function drawMaster(ctx: CanvasRenderingContext2D, bmp: Bitmap, cropped: PixelCrop, outW: number, outH: number) {
  // Background — cover the whole canvas with the flyer, blurred + slightly dark.
  const s = Math.max(outW / bmp.width, outH / bmp.height);
  const dw = bmp.width * s, dh = bmp.height * s;
  if (supportsCanvasBlur()) ctx.filter = 'blur(28px)';
  ctx.drawImage(bmp, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(4,2,10,0.32)';
  ctx.fillRect(0, 0, outW, outH);

  // Foreground — map the crop region onto the output. Where the flyer doesn't
  // cover the region (zoomed out), the background remains visible.
  const scale = outW / cropped.width;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, -cropped.x * scale, -cropped.y * scale, bmp.width * scale, bmp.height * scale);
}

async function renderMaster(bmp: Bitmap, cropped: PixelCrop, quality: number): Promise<Blob> {
  const outW = Math.max(1, Math.min(MASTER_W, Math.round(cropped.width))); // never upscale, cap at master
  const outH = Math.round(outW * 5 / 4); // 4:5 portrait
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');
  drawMaster(ctx, bmp, cropped, outW, outH);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { blob ? resolve(blob) : reject(new Error('Canvas is empty')); }, 'image/jpeg', quality);
  });
}

function haptic(pattern: number | number[] = 8) {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

const GUIDANCE =
  'Keep important text, faces and logos inside the highlighted safe area to ensure they appear correctly across VENTS. Your flyer becomes a portrait (4:5) master — drag or zoom out to fit the whole image.';

// Live preview layouts at their REAL production aspect ratios, so the organizer
// sees the exact crop each surface shows — Explore & Details are the portrait
// card box (4:5); Trending & Featured are the compact horizontal card (a wide
// band of the master). The master dataURL is object-fit:cover'd into each, which
// is exactly how the cards render it — so preview == published.
const TRENDING_ASPECT = 162 / 110; // HorizontalEventCard image box
const PREVIEW_LAYOUTS = [
  { key: 'explore', label: 'Explore', aspect: EVENT_CARD_ASPECT, radius: 12 },
  { key: 'trending', label: 'Trending', aspect: TRENDING_ASPECT, radius: 10 },
  { key: 'featured', label: 'Featured', aspect: TRENDING_ASPECT, radius: 10 },
  { key: 'details', label: 'Details', aspect: EVENT_CARD_ASPECT, radius: 12 },
];

export function ImageCropperModal({
  imageSrc, onCropComplete, onClose,
  aspect: aspectProp, cropShape = 'round', title = 'Crop Photo', variant = 'avatar',
}: ImageCropperModalProps) {
  const isFlyer = variant === 'flyer';

  const RATIOS = [
    { key: 'card', label: 'Portrait', value: EVENT_CARD_ASPECT },
    { key: 'square', label: 'Square', value: 1 },
    { key: 'wide', label: 'Wide', value: 4 / 3 },
    { key: 'original', label: 'Original', value: 0 },
  ];
  const [ratioKey, setRatioKey] = useState('card');

  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<PixelCrop | null>(null);
  const [cropSize, setCropSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const bitmapRef = useRef<Bitmap | null>(null);
  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);
  const [smartCrop, setSmartCrop] = useState<AreaPct | null>(null);
  const [cropperReady, setCropperReady] = useState(!isFlyer);
  // Reset-to-Auto: `dirty` flips once the user moves the image/zoom; `resetNonce`
  // remounts the cropper with the smart crop as the initial region.
  const [dirty, setDirty] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);
  // Vision (serverless) focus-aware framing — refines the instant heuristic.
  const [aiFraming, setAiFraming] = useState(false);
  const [visionFocus, setVisionFocus] = useState<VisionFocus | null>(null);

  const aspect = isFlyer
    ? (ratioKey === 'original' ? (naturalAspect ?? EVENT_CARD_ASPECT)
       : RATIOS.find((r) => r.key === ratioKey)?.value || EVENT_CARD_ASPECT)
    : (aspectProp ?? 1);

  // Decode once for the flyer path — reused for the live preview (every drag)
  // and the final export, so the image is never re-decoded per frame.
  useEffect(() => {
    if (!isFlyer) return;
    let alive = true;
    // Fallback so a slow decode never blocks the cropper (centered crop).
    const fallback = window.setTimeout(() => { if (alive) setCropperReady(true); }, 1400);
    decodeImage(imageSrc).then((bmp) => {
      if (!alive) return;
      bitmapRef.current = bmp;
      if (bmp.width && bmp.height) setNaturalAspect(bmp.width / bmp.height);
      // 1) Instant on-device heuristic — the cropper opens focus-framed with no wait.
      try { setSmartCrop(computeSmartCropCached(imageSrc, bmp, EVENT_CARD_ASPECT)); } catch { /* ignore */ }
      window.clearTimeout(fallback);
      setCropperReady(true);
      // 2) Refine with the serverless vision endpoint (faces/logos/title). Best-
      //    effort; null on any failure/timeout leaves the heuristic in place.
      setAiFraming(true);
      fetchVisionFocus(bmp).then((r) => {
        if (!alive) return;
        setAiFraming(false);
        if (r) setVisionFocus(r);
      }).catch(() => { if (alive) setAiFraming(false); });
    }).catch(() => { window.clearTimeout(fallback); setCropperReady(true); });
    return () => { alive = false; window.clearTimeout(fallback); };
  }, [imageSrc, isFlyer]);

  // Apply the vision focus once it arrives — but only if the organizer hasn't
  // already adjusted the crop (manual always wins). Remounts so the new initial
  // crop takes effect; Reset to Auto then restores THIS (the best) framing.
  useEffect(() => {
    if (!visionFocus || dirty || ratioKey !== 'card') return;
    const bmp = bitmapRef.current;
    if (!bmp?.width || !bmp?.height) return;
    setSmartCrop(cropFromFocus(bmp.width, bmp.height, EVENT_CARD_ASPECT, visionFocus.focus.x, visionFocus.focus.y));
    setResetNonce((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visionFocus]);

  // Dynamic minimum zoom: the whole flyer must always be viewable, whatever its
  // orientation. At zoom 1 react-easy-crop's media COVERS the crop frame; to
  // CONTAIN it (see all of it) the zoom ratio is min(Ai,Ac)/max(Ai,Ac). This
  // replaces the old hardcoded minZoom=1 that trapped landscape/square uploads.
  const recomputeMinZoom = useCallback((mediaW: number, mediaH: number) => {
    if (!mediaW || !mediaH) return;
    const Ai = mediaW / mediaH;
    const Ac = aspect;
    const contain = Math.min(Ai, Ac) / Math.max(Ai, Ac);
    const mz = Math.max(0.1, Math.min(1, contain));
    setMinZoom(mz);
    setZoom((z) => Math.max(mz, Math.min(z, 3)));
  }, [aspect]);

  const onCropCompleteCallback = useCallback((_a: any, areaPixels: PixelCrop) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  // Debounced live preview — render the exact portrait master (incl. background
  // fill when zoomed out) at small size, shown through EventCardImage.
  useEffect(() => {
    if (!isFlyer || !croppedAreaPixels) return;
    const t = window.setTimeout(() => {
      const bmp = bitmapRef.current;
      if (!bmp) return;
      const pw = 300, ph = Math.round(pw * 5 / 4);
      const c = document.createElement('canvas');
      c.width = pw; c.height = ph;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      drawMaster(ctx, bmp, croppedAreaPixels, pw, ph);
      try { setPreviewUrl(c.toDataURL('image/jpeg', 0.82)); } catch { /* ignore */ }
    }, 90);
    return () => window.clearTimeout(t);
  }, [croppedAreaPixels, isFlyer]);

  const handleSave = async () => {
    try {
      if (!croppedAreaPixels) return;
      setError(null);
      setBusy(true);
      haptic(12);
      const bmp = bitmapRef.current ?? (await decodeImage(imageSrc));
      const blob = isFlyer
        ? await renderMaster(bmp, croppedAreaPixels, 0.92)
        : await renderAvatar(bmp, croppedAreaPixels);
      onCropComplete(blob);
    } catch (e) {
      console.error('Failed to crop image:', e);
      setError('Could not crop this image. Try again or pick a different photo.');
      setBusy(false);
    }
  };

  const selectRatio = (key: string) => { setRatioKey(key); haptic(6); };

  // Reset-to-Auto — remount the cropper so the smart (auto) crop re-applies.
  const resetToAuto = () => { setCrop({ x: 0, y: 0 }); setZoom(1); setDirty(false); setResetNonce((n) => n + 1); haptic(10); };

  // Non-blocking geometric guidance (#16). The portrait master is shown as a
  // wide band in Trending/Featured, so top/bottom safe-area content is hidden
  // there — deterministic from the layout ratios (no ML claim). Dismissible.
  const [warnDismissed, setWarnDismissed] = useState(false);
  const showWarning = isFlyer && !warnDismissed;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: '#020005', zIndex: 2000, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'calc(16px + env(safe-area-inset-top, 44px)) 16px 10px',
        background: isFlyer ? 'transparent' : '#090514',
        borderBottom: isFlyer ? 'none' : '1px solid rgba(255,255,255,0.08)',
        position: isFlyer ? 'absolute' : 'relative', left: 0, right: 0, top: 0, zIndex: 3,
      }}>
        <button onClick={onClose} aria-label="Cancel" style={floatBtn}><X size={20} /></button>
        <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', flex: 1, textAlign: 'center', textShadow: isFlyer ? '0 1px 8px rgba(0,0,0,0.6)' : 'none' }}>{title}</span>
        <button onClick={handleSave} disabled={busy} style={{ ...doneBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
          <Check size={14} />{busy ? 'Saving…' : 'Done'}
        </button>
      </div>

      {/* Cropper — gated until the smart initial crop is computed (flyer) so it
          mounts with the focus-aware crop already applied. */}
      <div style={{ flex: 1, position: 'relative', background: '#000', overflow: 'hidden' }}>
        {cropperReady && (
        <Cropper
          key={resetNonce}
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          minZoom={isFlyer ? minZoom : 1}
          maxZoom={5}
          zoomSpeed={0.25}
          aspect={aspect}
          cropShape={isFlyer ? 'rect' : cropShape}
          showGrid={isFlyer}
          restrictPosition={!isFlyer}
          objectFit="cover"
          initialCroppedAreaPercentages={isFlyer && ratioKey === 'card' && smartCrop ? smartCrop : undefined}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropCompleteCallback}
          onCropSizeChange={(s) => setCropSize(s)}
          onMediaLoaded={(m: any) => { if (isFlyer) recomputeMinZoom(m.naturalWidth, m.naturalHeight); }}
          // Only genuine user gestures mark the crop "dirty" (not the initial
          // programmatic zoom/crop that applies the smart crop on mount).
          onInteractionStart={() => { haptic(5); if (isFlyer) setDirty(true); }}
          style={{ cropAreaStyle: { borderRadius: isFlyer ? '22px' : '0', border: '2px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 9999px rgba(2,0,5,0.62)' } }}
        />
        )}

        {/* Safe-area overlay, aligned to the real crop frame */}
        {isFlyer && cropSize && (
          <div aria-hidden style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: cropSize.width, height: cropSize.height, pointerEvents: 'none', borderRadius: '22px', overflow: 'hidden' }}>
            {/* Universal safe zone — the region most likely to stay visible on
                every surface (incl. the wide Trending/Featured band). */}
            <div style={{ position: 'absolute', top: '8%', left: '7%', right: '7%', bottom: '11%', border: '1.5px dashed rgba(255,255,255,0.5)', borderRadius: '14px' }} />
            {/* Tighter band = what the landscape cards keep; strongest hint. */}
            <div style={{ position: 'absolute', top: '23%', left: '7%', right: '7%', bottom: '23%', border: '1px solid rgba(167,139,250,0.5)', borderRadius: '10px' }} />
            <span style={zoneLabel('top')}>Logos · Sponsors</span>
            <span style={zoneLabel('center')}>Faces · Headliners · Title</span>
            <span style={zoneLabel('bottom')}>Date · Venue · Info</span>
          </div>
        )}

        {/* Vision smart-framing indicator (serverless). */}
        {isFlyer && aiFraming && (
          <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 'calc(64px + env(safe-area-inset-top, 44px))', zIndex: 3, display: 'flex', alignItems: 'center', gap: '7px', background: 'rgba(20,14,36,0.72)', border: '1px solid rgba(167,139,250,0.4)', borderRadius: '999px', padding: '6px 12px', backdropFilter: 'blur(8px)', pointerEvents: 'none' }}>
            <Sparkles size={13} color="#C4B5FD" />
            <span style={{ color: '#DDD3FF', fontSize: '11px', fontWeight: 700 }}>Smart framing…</span>
          </div>
        )}
      </div>

      {/* Controls */}
      {isFlyer ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '12px 14px calc(14px + env(safe-area-inset-bottom, 8px))', background: 'linear-gradient(to top, rgba(2,0,5,0.97) 60%, transparent)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {error && <div style={{ color: '#EF4444', fontSize: '12px', fontWeight: 600, textAlign: 'center' }}>{error}</div>}

          {/* Non-blocking guidance the organizer can dismiss (#16) */}
          {showWarning && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '10px', padding: '7px 10px' }}>
              <span style={{ fontSize: '13px' }}>⚠️</span>
              <span style={{ flex: 1, color: '#FCD9A6', fontSize: '10.5px', lineHeight: 1.35 }}>Trending &amp; Featured show a wide band — keep titles, faces and dates inside the inner (purple) zone so nothing important is cropped there.</span>
              <button onClick={() => setWarnDismissed(true)} style={{ background: 'none', border: 'none', color: '#B9BED6', cursor: 'pointer', padding: '2px', flexShrink: 0 }} aria-label="Dismiss"><X size={14} /></button>
            </div>
          )}

          {/* Live per-layout preview at each surface's REAL aspect — object-fit
              cover'd exactly like the cards, so preview == published (#15). */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', alignItems: 'flex-end' }}>
            {PREVIEW_LAYOUTS.map((c) => (
              <div key={c.key} style={{ width: '62px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '100%', aspectRatio: String(c.aspect), borderRadius: c.radius, overflow: 'hidden', background: '#0B0618', border: '1px solid rgba(255,255,255,0.14)' }}>
                  {previewUrl && <img src={previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                </div>
                <div style={{ textAlign: 'center', color: '#B9BED6', fontSize: '9px', fontWeight: 600, marginTop: '3px' }}>{c.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
            <p style={{ margin: 0, color: '#C4C9E0', fontSize: '11px', lineHeight: 1.45, textAlign: 'center', flex: 1 }}>{GUIDANCE}</p>
          </div>

          {/* Reset to Auto — restores the intelligent framing after manual edits (#17) */}
          {dirty && (
            <button onClick={resetToAuto} style={{
              alignSelf: 'center', display: 'flex', alignItems: 'center', gap: '6px',
              background: 'rgba(167,139,250,0.16)', border: '1px solid rgba(167,139,250,0.5)',
              borderRadius: '999px', padding: '7px 14px', color: '#DDD3FF', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            }}>
              <RotateCcw size={13} /> Reset to Auto
            </button>
          )}

          {/* Aspect selector */}
          <div style={{ display: 'flex', gap: '7px', justifyContent: 'center' }}>
            {RATIOS.map((r) => {
              const active = ratioKey === r.key;
              return (
                <button key={r.key} onClick={() => selectRatio(r.key)} style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  background: active ? 'rgba(167,139,250,0.22)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${active ? 'rgba(167,139,250,0.7)' : 'rgba(255,255,255,0.12)'}`,
                  borderRadius: '999px', padding: '6px 11px', color: active ? '#DDD3FF' : '#B9BED6',
                  fontSize: '11.5px', fontWeight: 700, cursor: 'pointer',
                }}>
                  {r.key === 'card' && <CropIcon size={11} />}{r.label}
                </button>
              );
            })}
          </div>

          {/* Zoom — min is dynamic so the whole flyer is always reachable */}
          <input type="range" value={zoom} min={minZoom} max={5} step={0.01} aria-label="Zoom"
            onChange={(e) => { setZoom(Number(e.target.value)); setDirty(true); }} onPointerUp={() => haptic(4)}
            style={{ width: '100%', height: '4px', borderRadius: '3px', outline: 'none', accentColor: '#A78BFA', cursor: 'pointer' }} />
        </div>
      ) : (
        <div style={{ padding: '12px 16px', background: '#090514', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {error && <div style={{ color: '#EF4444', fontSize: '12px', fontWeight: 600, textAlign: 'center' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>
            <span>Zoom</span><span>{Math.round(zoom * 100)}%</span>
          </div>
          <input type="range" value={zoom} min={1} max={3} step={0.1} aria-label="Zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
            style={{ width: '100%', height: '6px', borderRadius: '3px', outline: 'none', accentColor: '#7B2FBE', cursor: 'pointer' }} />
        </div>
      )}
    </div>,
    document.body,
  );
}

// Avatar export — native-resolution square crop, unchanged behaviour.
async function renderAvatar(bmp: Bitmap, cropped: PixelCrop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cropped.width));
  canvas.height = Math.max(1, Math.round(cropped.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, cropped.x, cropped.y, cropped.width, cropped.height, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { blob ? resolve(blob) : reject(new Error('Canvas is empty')); }, 'image/jpeg', 0.85);
  });
}

const floatBtn: React.CSSProperties = {
  background: 'rgba(20,14,36,0.6)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '999px',
  width: '36px', height: '36px', color: '#EDEBFF', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)',
};
const doneBtn: React.CSSProperties = {
  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '999px',
  height: '36px', padding: '0 16px', color: '#fff', fontSize: '13px', fontWeight: 700,
  fontFamily: 'Space Grotesk, sans-serif', display: 'flex', alignItems: 'center', gap: '6px', boxShadow: '0 6px 16px rgba(123,47,190,0.4)',
};
function zoneLabel(where: 'top' | 'center' | 'bottom'): React.CSSProperties {
  const v = where === 'top' ? { top: '11%' } : where === 'bottom' ? { bottom: '13%' } : { top: '50%' };
  return {
    position: 'absolute', left: '50%',
    transform: where === 'center' ? 'translate(-50%,-50%)' : 'translateX(-50%)', ...v,
    color: 'rgba(255,255,255,0.6)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase', textShadow: '0 1px 4px rgba(0,0,0,0.7)', whiteSpace: 'nowrap',
  } as React.CSSProperties;
}
