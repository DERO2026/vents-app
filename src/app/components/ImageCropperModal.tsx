import { useState, useCallback } from 'react';
import Cropper from 'react-easy-crop';
import { X, Check } from 'lucide-react';

interface ImageCropperModalProps {
  imageSrc: string;
  onCropComplete: (croppedBlob: Blob) => void;
  onClose: () => void;
  aspect?: number;
  cropShape?: 'round' | 'rect';
  title?: string;
}

// Mobile camera photos routinely carry EXIF orientation metadata (portrait
// shots especially) rather than physically-rotated pixel data. Decoding via
// createImageBitmap with imageOrientation: 'from-image' explicitly asks the
// browser to bake that rotation into the decoded bitmap before we ever draw
// it — the source of the classic "cropped photo comes out sideways" bug,
// since a plain canvas drawImage(<img>) does not reliably apply it the same
// way across engines/versions. Falls back to the old <img> path if the
// browser doesn't support createImageBitmap or the orientation option.
async function decodeImage(imageSrc: string): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    const blob = await fetch(imageSrc).then((r) => r.blob());
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const image = new Image();
    image.src = imageSrc;
    image.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    return image;
  }
}

async function getCroppedImg(
  imageSrc: string,
  pixelCrop: { x: number; y: number; width: number; height: number }
): Promise<Blob> {
  const image = await decodeImage(imageSrc);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('No 2d context');
  }

  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas is empty'));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', 0.85);
  });
}

export function ImageCropperModal({ imageSrc, onCropComplete, onClose, aspect = 1, cropShape = 'round', title = 'Crop Photo' }: ImageCropperModalProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const onCropCompleteCallback = useCallback((croppedArea: any, croppedAreaPixels: any) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const handleSave = async () => {
    try {
      if (!croppedAreaPixels) return;
      setError(null);
      const croppedBlob = await getCroppedImg(imageSrc, croppedAreaPixels);
      onCropComplete(croppedBlob);
    } catch (e) {
      console.error('Failed to crop image:', e);
      setError('Could not crop this image. Try again or pick a different photo.');
    }
  };

  return (
    <div
      style={{
        // position:'fixed', not 'absolute' — this modal is rendered nested
        // three levels deep inside display:flex containers (CreateEventScreen
        // root -> scrollable form content -> the step-1 field column), all
        // position:static, before reaching the app shell's own position:fixed
        // frame. Real iOS Safari has documented inconsistencies resolving the
        // containing block for an absolutely-positioned element through that
        // many static flex ancestors — confirmed live: the modal was
        // anchoring to something smaller than the full screen, rendering
        // BELOW the host screen's own header/step-indicator instead of over
        // it, hiding this modal's own header (with the Done button) entirely.
        // position:fixed always resolves against the true viewport (or the
        // nearest transform/filter ancestor) and never binds to a static flex
        // container, so it cannot inherit that ambiguity.
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: '#020005',
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          // Matches CreateEventScreen's own header offset (20px base) — the
          // previous 8px base left too little clearance on notched/Dynamic
          // Island iPhones: the X/Done buttons rendered up under the status
          // bar overlay, technically present and still tappable (the status
          // bar doesn't block touches to page content) but visually hidden.
          padding: 'calc(20px + env(safe-area-inset-top, 44px)) 16px 8px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          background: '#090514',
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#8B8FA8',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={20} />
        </button>
        <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', flex: 1, textAlign: 'center' }}>
          {title}
        </span>
        <button
          onClick={handleSave}
          style={{
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '20px',
            height: '32px',
            padding: '0 14px',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            boxShadow: '0 4px 10px rgba(123,47,190,0.3)',
          }}
        >
          <Check size={14} />
          Done
        </button>
      </div>

      {/* Cropper Container */}
      <div style={{ flex: 1, position: 'relative', background: '#000' }}>
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          cropShape={cropShape}
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={onCropCompleteCallback}
        />
      </div>

      {/* Zoom Controls */}
      <div
        style={{
          padding: '12px 16px',
          background: '#090514',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        {error && (
          <div style={{ color: '#EF4444', fontSize: '12px', fontWeight: 600, textAlign: 'center' }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>
          <span>Zoom</span>
          <span>{Math.round(zoom * 100)}%</span>
        </div>
        <input
          type="range"
          value={zoom}
          min={1}
          max={3}
          step={0.1}
          aria-label="Zoom"
          onChange={(e) => setZoom(Number(e.target.value))}
          style={{
            width: '100%',
            height: '6px',
            borderRadius: '3px',
            outline: 'none',
            accentColor: '#7B2FBE',
            cursor: 'pointer',
          }}
        />
      </div>
    </div>
  );
}
