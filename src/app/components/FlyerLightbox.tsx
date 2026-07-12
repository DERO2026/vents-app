import { useEffect, useRef, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

interface FlyerLightboxProps {
  images: string[];
  initialIndex?: number;
  alt: string;
  onClose: () => void;
}

// Full-screen tap-to-expand viewer for the Event Details flyer. Fades and
// scales in/out rather than snapping open, shows the whole image
// (object-contain, never cropped), and supports swiping between multiple
// flyer images when there's more than one.
export function FlyerLightbox({ images, initialIndex = 0, alt, onClose }: FlyerLightboxProps) {
  const validImages = images.filter(Boolean);
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(0, validImages.length - 1)));
  const [visible, setVisible] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    setTimeout(onClose, 220);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = (next: number) => setIndex((next + validImages.length) % validImages.length);

  const handleTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.touches[0].clientX; };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || validImages.length <= 1) { touchStartX.current = null; return; }
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 50) return;
    goTo(index + (dx < 0 ? 1 : -1));
  };

  if (validImages.length === 0) return null;

  return (
    <div
      onClick={handleClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(2,0,5,0.97)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.22s ease',
      }}
    >
      <img
        src={validImages[index]}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92%',
          maxHeight: '82%',
          objectFit: 'contain',
          borderRadius: '16px',
          transform: visible ? 'scale(1)' : 'scale(0.94)',
          transition: 'transform 0.22s ease',
        }}
      />

      <button
        onClick={(e) => { e.stopPropagation(); handleClose(); }}
        style={{
          position: 'absolute', top: '20px', right: '16px',
          width: '38px', height: '38px', borderRadius: '50%',
          background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
      >
        <X size={18} color="#fff" />
      </button>

      {validImages.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); goTo(index - 1); }}
            style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', width: '38px', height: '38px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <ChevronLeft size={20} color="#fff" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goTo(index + 1); }}
            style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', width: '38px', height: '38px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <ChevronRight size={20} color="#fff" />
          </button>
          <div style={{ position: 'absolute', bottom: '28px', left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: '6px' }}>
            {validImages.map((_, i) => (
              <span
                key={i}
                onClick={(e) => { e.stopPropagation(); setIndex(i); }}
                style={{ width: i === index ? '18px' : '7px', height: '7px', borderRadius: '4px', background: i === index ? '#A78BFA' : 'rgba(255,255,255,0.4)', transition: 'width 0.25s ease' }}
              />
            ))}
          </div>
        </>
      )}

      <span style={{ position: 'absolute', bottom: validImages.length > 1 ? '56px' : '24px', left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.55)', fontSize: '11px' }}>
        Tap outside to close
      </span>
    </div>
  );
}
