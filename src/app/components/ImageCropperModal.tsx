import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Cropper from 'react-easy-crop';
import { X, Check, Crop as CropIcon } from 'lucide-react';
import { EVENT_CARD_ASPECT, EVENT_CARD_ASPECT_CSS } from '../../lib/eventCardAspect';
import { EventCardImage } from './EventCardImage';
import { computeSmartCrop, type AreaPct } from '../../lib/smartCrop';

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

// The card contexts previewed live. All share the portrait image box, so one
// rendered master is faithful to each; Event Details just uses a larger radius.
const PREVIEW_CONTEXTS = [
  { key: 'explore', label: 'Explore', radius: 12 },
  { key: 'trending', label: 'Trending', radius: 12 },
  { key: 'featured', label: 'Featured', radius: 12 },
  { key: 'details', label: 'Details', radius: 16 },
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
      // Content-aware smart initial crop for the master (portrait) ratio.
      try { setSmartCrop(computeSmartCrop(bmp, EVENT_CARD_ASPECT)); } catch { /* ignore */ }
      window.clearTimeout(fallback);
      setCropperReady(true);
    }).catch(() => { window.clearTimeout(fallback); setCropperReady(true); });
    return () => { alive = false; window.clearTimeout(fallback); };
  }, [imageSrc, isFlyer]);

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
          onInteractionStart={() => haptic(5)}
          style={{ cropAreaStyle: { borderRadius: isFlyer ? '22px' : '0', border: '2px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 9999px rgba(2,0,5,0.62)' } }}
        />
        )}

        {/* Safe-area overlay, aligned to the real crop frame */}
        {isFlyer && cropSize && (
          <div aria-hidden style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: cropSize.width, height: cropSize.height, pointerEvents: 'none', borderRadius: '22px', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: '8%', left: '7%', right: '7%', bottom: '11%', border: '1.5px dashed rgba(255,255,255,0.55)', borderRadius: '14px' }} />
            <span style={zoneLabel('top')}>Logos · Sponsors</span>
            <span style={zoneLabel('center')}>Faces · Title</span>
            <span style={zoneLabel('bottom')}>Dates · Info</span>
          </div>
        )}
      </div>

      {/* Controls */}
      {isFlyer ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '12px 14px calc(14px + env(safe-area-inset-bottom, 8px))', background: 'linear-gradient(to top, rgba(2,0,5,0.97) 60%, transparent)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {error && <div style={{ color: '#EF4444', fontSize: '12px', fontWeight: 600, textAlign: 'center' }}>{error}</div>}

          {/* Live multi-context preview — the same portrait image box the cards use */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            {PREVIEW_CONTEXTS.map((c) => (
              <div key={c.key} style={{ width: '58px' }}>
                <EventCardImage src={previewUrl} radius={c.radius} style={{ border: '1px solid rgba(255,255,255,0.14)' }} />
                <div style={{ textAlign: 'center', color: '#B9BED6', fontSize: '9px', fontWeight: 600, marginTop: '3px' }}>{c.label}</div>
              </div>
            ))}
          </div>

          <p style={{ margin: 0, color: '#C4C9E0', fontSize: '11px', lineHeight: 1.45, textAlign: 'center' }}>{GUIDANCE}</p>

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
            onChange={(e) => setZoom(Number(e.target.value))} onPointerUp={() => haptic(4)}
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
