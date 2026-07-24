import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Cropper from 'react-easy-crop';
import { X, Check, Crop as CropIcon } from 'lucide-react';
import { EVENT_CARD_ASPECT, EVENT_CARD_ASPECT_CSS } from '../../lib/eventCardAspect';

interface ImageCropperModalProps {
  imageSrc: string;
  onCropComplete: (croppedBlob: Blob) => void;
  onClose: () => void;
  aspect?: number;
  cropShape?: 'round' | 'rect';
  title?: string;
  /** 'avatar' keeps the compact circular cropper; 'flyer' is the premium,
   *  Apple-Photos-style event-flyer experience (safe area, live card preview,
   *  aspect selector, guidance). */
  variant?: 'avatar' | 'flyer';
}

type Bitmap = CanvasImageSource & { width: number; height: number };

// Mobile camera photos routinely carry EXIF orientation metadata (portrait
// shots especially) rather than physically-rotated pixel data. Decoding via
// createImageBitmap with imageOrientation: 'from-image' explicitly asks the
// browser to bake that rotation into the decoded bitmap before we ever draw
// it — the source of the classic "cropped photo comes out sideways" bug,
// since a plain canvas drawImage(<img>) does not reliably apply it the same
// way across engines/versions. Falls back to the old <img> path if the
// browser doesn't support createImageBitmap or the orientation option.
async function decodeImage(imageSrc: string): Promise<Bitmap> {
  try {
    const blob = await fetch(imageSrc).then((r) => r.blob());
    return (await createImageBitmap(blob, { imageOrientation: 'from-image' })) as Bitmap;
  } catch {
    const image = new Image();
    image.src = imageSrc;
    image.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    return image as Bitmap;
  }
}

type PixelCrop = { x: number; y: number; width: number; height: number };

// Export the exact cropped region at its NATIVE resolution — the canvas is
// sized to the source pixels of the crop, so a low-res source is never
// upscaled (we only ever draw 1:1 or downscale). Quality is high for flyers so
// posters stay sharp; the media pipeline downstream generates the responsive
// thumbnail + card sizes and does the intelligent compression for delivery.
async function getCroppedImg(bitmap: Bitmap, pixelCrop: PixelCrop, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');

  canvas.width = Math.max(1, Math.round(pixelCrop.width));
  canvas.height = Math.max(1, Math.round(pixelCrop.height));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    bitmap,
    pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
    0, 0, canvas.width, canvas.height,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('Canvas is empty')); return; }
      resolve(blob);
    }, 'image/jpeg', quality);
  });
}

function haptic(pattern: number | number[] = 8) {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try { navigator.vibrate(pattern); } catch { /* ignore */ }
}

const GUIDANCE =
  'Your flyer is automatically optimized for VENTS event cards. Keep important text, faces, and logos inside the highlighted safe area so they appear correctly across the app.';

export function ImageCropperModal({
  imageSrc, onCropComplete, onClose,
  aspect: aspectProp, cropShape = 'round', title = 'Crop Photo', variant = 'avatar',
}: ImageCropperModalProps) {
  const isFlyer = variant === 'flyer';

  // Flyer crop is locked to the canonical Event Card ratio by default so the
  // preview is exactly what attendees see; the selector lets power users pick
  // another ratio and SEE (in the live preview) how it maps onto a card.
  const RATIOS = [
    { key: 'card', label: 'Card', value: EVENT_CARD_ASPECT },
    { key: 'square', label: 'Square', value: 1 },
    { key: 'wide', label: 'Wide', value: 4 / 3 },
    { key: 'original', label: 'Original', value: 0 }, // 0 → natural aspect, filled in after decode
  ];
  const [ratioKey, setRatioKey] = useState('card');

  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<PixelCrop | null>(null);
  const [cropSize, setCropSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const bitmapRef = useRef<Bitmap | null>(null);
  const [naturalAspect, setNaturalAspect] = useState<number | null>(null);

  const aspect = isFlyer
    ? (ratioKey === 'original' ? (naturalAspect ?? EVENT_CARD_ASPECT)
       : RATIOS.find((r) => r.key === ratioKey)?.value || EVENT_CARD_ASPECT)
    : (aspectProp ?? 1);

  // Decode the source ONCE for the flyer path — reused for both the live
  // preview (many times, as the user drags) and the final export, so we never
  // re-fetch/re-decode the image on every frame.
  useEffect(() => {
    if (!isFlyer) return;
    let alive = true;
    decodeImage(imageSrc).then((bmp) => {
      if (!alive) return;
      bitmapRef.current = bmp;
      if (bmp.width && bmp.height) setNaturalAspect(bmp.width / bmp.height);
    }).catch(() => {});
    return () => { alive = false; };
  }, [imageSrc, isFlyer]);

  const onCropCompleteCallback = useCallback((_area: any, areaPixels: PixelCrop) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  // Debounced live preview: draw the current crop from the cached bitmap into a
  // small canvas at the CARD ratio, exactly what the Event Card will show.
  useEffect(() => {
    if (!isFlyer || !croppedAreaPixels) return;
    const t = window.setTimeout(() => {
      const bmp = bitmapRef.current;
      if (!bmp) return;
      const pw = 260;
      const ph = Math.round(pw / EVENT_CARD_ASPECT);
      const c = document.createElement('canvas');
      c.width = pw; c.height = ph;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingQuality = 'high';
      // objectFit:cover — the card crops the (possibly non-card-ratio) export to
      // the card box, so the preview mirrors production exactly.
      const cr = croppedAreaPixels;
      const srcAspect = cr.width / cr.height;
      let sx = cr.x, sy = cr.y, sw = cr.width, sh = cr.height;
      if (srcAspect > EVENT_CARD_ASPECT) { // too wide → trim sides
        sw = cr.height * EVENT_CARD_ASPECT; sx = cr.x + (cr.width - sw) / 2;
      } else if (srcAspect < EVENT_CARD_ASPECT) { // too tall → trim top/bottom
        sh = cr.width / EVENT_CARD_ASPECT; sy = cr.y + (cr.height - sh) / 2;
      }
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, pw, ph);
      try { setPreviewUrl(c.toDataURL('image/jpeg', 0.82)); } catch { /* ignore */ }
    }, 110);
    return () => window.clearTimeout(t);
  }, [croppedAreaPixels, isFlyer]);

  const handleSave = async () => {
    try {
      if (!croppedAreaPixels) return;
      setError(null);
      setBusy(true);
      haptic(12);
      const bmp = bitmapRef.current ?? (await decodeImage(imageSrc));
      const croppedBlob = await getCroppedImg(bmp, croppedAreaPixels, isFlyer ? 0.92 : 0.85);
      onCropComplete(croppedBlob);
    } catch (e) {
      console.error('Failed to crop image:', e);
      setError('Could not crop this image. Try again or pick a different photo.');
      setBusy(false);
    }
  };

  const selectRatio = (key: string) => { setRatioKey(key); haptic(6); };

  // Rendered via a portal straight to document.body — not just position:fixed
  // on an inline div — because this modal is normally mounted deep inside
  // CreateEventScreen's own scrollable "form content" container (overflowY:
  // 'auto'), which itself sits inside the app shell's .phone-frame
  // (position:fixed AND overflow:hidden, App.tsx). Real iOS Safari traps a
  // position:fixed descendant nested inside a scrollable/overflow-clipped
  // ancestor; a portal to document.body removes it from that ancestor chain.
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: '#020005', zIndex: 2000, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'calc(16px + env(safe-area-inset-top, 44px)) 16px 10px',
          background: isFlyer ? 'transparent' : '#090514',
          borderBottom: isFlyer ? 'none' : '1px solid rgba(255,255,255,0.08)',
          position: isFlyer ? 'absolute' : 'relative', left: 0, right: 0, top: 0, zIndex: 3,
        }}
      >
        <button onClick={onClose} aria-label="Cancel" style={floatBtn}>
          <X size={20} />
        </button>
        <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', flex: 1, textAlign: 'center', textShadow: isFlyer ? '0 1px 8px rgba(0,0,0,0.6)' : 'none' }}>
          {title}
        </span>
        <button onClick={handleSave} disabled={busy} style={{ ...doneBtn, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}>
          <Check size={14} />
          {busy ? 'Saving…' : 'Done'}
        </button>
      </div>

      {/* Cropper */}
      <div style={{ flex: 1, position: 'relative', background: '#000', overflow: 'hidden' }}>
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          minZoom={1}
          maxZoom={5}
          zoomSpeed={0.25}
          aspect={aspect}
          cropShape={isFlyer ? 'rect' : cropShape}
          showGrid={isFlyer}
          restrictPosition
          objectFit="cover"
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropCompleteCallback}
          onCropSizeChange={(s) => setCropSize(s)}
          onInteractionStart={() => haptic(5)}
          style={{ cropAreaStyle: { borderRadius: isFlyer ? '22px' : '0', border: '2px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 9999px rgba(2,0,5,0.62)' } }}
        />

        {/* Safe-area overlay — positioned to the real crop frame via cropSize */}
        {isFlyer && cropSize && (
          <div
            aria-hidden
            style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              width: cropSize.width, height: cropSize.height, pointerEvents: 'none',
              borderRadius: '22px', overflow: 'hidden',
            }}
          >
            {/* Recommended safe rect */}
            <div style={{
              position: 'absolute', top: '8%', left: '7%', right: '7%', bottom: '11%',
              border: '1.5px dashed rgba(255,255,255,0.55)', borderRadius: '14px',
            }} />
            {/* Zone hints */}
            <span style={zoneLabel('7%', 'top')}>Logo</span>
            <span style={zoneLabel('50%', 'center')}>Faces · Title</span>
            <span style={zoneLabel('7%', 'bottom')}>Key info</span>
          </div>
        )}

        {/* Live card preview — identical rendering to production Event Cards */}
        {isFlyer && (
          <div style={{ position: 'absolute', right: '12px', top: 'calc(64px + env(safe-area-inset-top, 44px))', width: '72px', zIndex: 3, pointerEvents: 'none' }}>
            <div style={{
              width: '100%', aspectRatio: EVENT_CARD_ASPECT_CSS, borderRadius: '12px', overflow: 'hidden',
              background: '#0B0618', border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
            }}>
              {previewUrl && <img src={previewUrl} alt="Card preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            </div>
            <div style={{ textAlign: 'center', color: '#B9BED6', fontSize: '9px', fontWeight: 600, marginTop: '4px', textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}>Card preview</div>
          </div>
        )}
      </div>

      {/* Controls */}
      {isFlyer ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '14px 16px calc(16px + env(safe-area-inset-bottom, 8px))', background: 'linear-gradient(to top, rgba(2,0,5,0.96) 55%, transparent)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {error && <div style={{ color: '#EF4444', fontSize: '12px', fontWeight: 600, textAlign: 'center' }}>{error}</div>}

          {/* Guidance — only shown here, during upload/crop */}
          <p style={{ margin: 0, color: '#C4C9E0', fontSize: '11.5px', lineHeight: 1.5, textAlign: 'center' }}>{GUIDANCE}</p>

          {/* Aspect selector */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            {RATIOS.map((r) => {
              const active = ratioKey === r.key;
              return (
                <button key={r.key} onClick={() => selectRatio(r.key)} style={{
                  display: 'flex', alignItems: 'center', gap: '5px',
                  background: active ? 'rgba(167,139,250,0.22)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${active ? 'rgba(167,139,250,0.7)' : 'rgba(255,255,255,0.12)'}`,
                  borderRadius: '999px', padding: '7px 12px', color: active ? '#DDD3FF' : '#B9BED6',
                  fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                }}>
                  {r.key === 'card' && <CropIcon size={12} />}
                  {r.label}
                </button>
              );
            })}
          </div>

          {/* Zoom */}
          <input
            type="range" value={zoom} min={1} max={5} step={0.01} aria-label="Zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
            onPointerUp={() => haptic(4)}
            style={{ width: '100%', height: '4px', borderRadius: '3px', outline: 'none', accentColor: '#A78BFA', cursor: 'pointer' }}
          />
        </div>
      ) : (
        <div style={{ padding: '12px 16px', background: '#090514', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {error && <div style={{ color: '#EF4444', fontSize: '12px', fontWeight: 600, textAlign: 'center' }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>
            <span>Zoom</span><span>{Math.round(zoom * 100)}%</span>
          </div>
          <input
            type="range" value={zoom} min={1} max={3} step={0.1} aria-label="Zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
            style={{ width: '100%', height: '6px', borderRadius: '3px', outline: 'none', accentColor: '#7B2FBE', cursor: 'pointer' }}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}

const floatBtn: React.CSSProperties = {
  background: 'rgba(20,14,36,0.6)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '999px',
  width: '36px', height: '36px', color: '#EDEBFF', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  backdropFilter: 'blur(8px)',
};

const doneBtn: React.CSSProperties = {
  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '999px',
  height: '36px', padding: '0 16px', color: '#fff', fontSize: '13px', fontWeight: 700,
  fontFamily: 'Space Grotesk, sans-serif', display: 'flex', alignItems: 'center', gap: '6px',
  boxShadow: '0 6px 16px rgba(123,47,190,0.4)',
};

function zoneLabel(pos: string, where: 'top' | 'center' | 'bottom'): React.CSSProperties {
  const v = where === 'top' ? { top: '11%' } : where === 'bottom' ? { bottom: '13%' } : { top: '50%', transform: 'translate(-50%,-50%)' };
  return {
    position: 'absolute', left: '50%', ...(where === 'center' ? {} : { transform: 'translateX(-50%)' }), ...v,
    color: 'rgba(255,255,255,0.6)', fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase', textShadow: '0 1px 4px rgba(0,0,0,0.7)', whiteSpace: 'nowrap',
  } as React.CSSProperties;
}
