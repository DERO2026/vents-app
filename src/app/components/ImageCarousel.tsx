import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface ImageCarouselProps {
  images: string[];
  alt: string;
  style?: React.CSSProperties;
  imageFit?: 'cover' | 'contain';
  imageBackground?: string;
  /** Called on a genuine tap (not a swipe) with the currently-shown index. */
  onImageTap?: (index: number) => void;
  showArrows?: boolean;
  showDots?: boolean;
  fallbackIcon?: string;
  /**
   * When true, the container isn't given a fixed height — it sizes itself to
   * the current image's own intrinsic aspect ratio (capped by maxHeightVh),
   * so a portrait flyer renders full-width at its natural height instead of
   * being letterboxed/pillarboxed inside a fixed-shape box.
   */
  naturalAspect?: boolean;
  /** Cap on the natural-aspect box's height, in vh. Defaults to 70. */
  maxHeightVh?: number;
}

const FALLBACK_BG = 'linear-gradient(135deg, #1e1040 0%, #0f172a 100%)';

// Shared swipeable image carousel used by both the home feed cards and the
// Event Details flyer. Degrades gracefully: an empty/all-broken image list
// renders the same dark gradient placeholder every card in this app already
// uses on a load failure, instead of a broken-image icon.
export function ImageCarousel({
  images,
  alt,
  style,
  imageFit = 'cover',
  imageBackground,
  onImageTap,
  showArrows = false,
  showDots = true,
  fallbackIcon = '🎉',
  naturalAspect = false,
  maxHeightVh = 70,
}: ImageCarouselProps) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const touchStartX = useRef<number | null>(null);
  const didSwipeRef = useRef(false);

  const validImages = images.filter(Boolean);
  const clampedIndex = Math.min(index, Math.max(0, validImages.length - 1));
  const currentSrc = validImages[clampedIndex];
  const currentFailed = failed[clampedIndex];

  const goTo = (next: number) => setIndex((next + validImages.length) % validImages.length);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || validImages.length <= 1) {
      touchStartX.current = null;
      return;
    }
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    didSwipeRef.current = true;
    goTo(clampedIndex + (dx < 0 ? 1 : -1));
  };

  // A real swipe also fires a trailing click in most browsers -- swallow
  // just that one so it doesn't also trigger the card/onImageTap action.
  const handleClick = (e: React.MouseEvent) => {
    if (didSwipeRef.current) {
      didSwipeRef.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onImageTap?.(clampedIndex);
  };

  if (validImages.length === 0 || currentFailed) {
    return (
      <div style={{ ...style, background: FALLBACK_BG, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(naturalAspect ? { aspectRatio: '4 / 5', width: '100%' } : {}) }}>
        <span style={{ fontSize: '32px' }}>{fallbackIcon}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        ...style,
        position: 'relative',
        overflow: 'hidden',
        background: imageBackground || '#090514',
        ...(naturalAspect ? { display: 'flex', justifyContent: 'center' } : {}),
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onClick={handleClick}
    >
      <img
        src={currentSrc}
        alt={alt}
        loading="lazy"
        style={
          naturalAspect
            ? { width: '100%', height: 'auto', maxHeight: `${maxHeightVh}vh`, objectFit: 'contain', display: 'block' }
            : { width: '100%', height: '100%', objectFit: imageFit, display: 'block' }
        }
        onError={() => setFailed((f) => ({ ...f, [clampedIndex]: true }))}
      />

      {validImages.length > 1 && showArrows && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); goTo(clampedIndex - 1); }}
            style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(0,0,0,0.45)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <ChevronLeft size={16} color="#fff" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); goTo(clampedIndex + 1); }}
            style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(0,0,0,0.45)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <ChevronRight size={16} color="#fff" />
          </button>
        </>
      )}

      {validImages.length > 1 && showDots && (
        <div style={{ position: 'absolute', bottom: '10px', left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: '5px' }}>
          {validImages.map((_, i) => (
            <span
              key={i}
              onClick={(e) => { e.stopPropagation(); setIndex(i); }}
              style={{
                width: i === clampedIndex ? '16px' : '6px',
                height: '6px',
                borderRadius: '3px',
                background: i === clampedIndex ? '#A78BFA' : 'rgba(255,255,255,0.45)',
                transition: 'width 0.25s ease',
                boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
