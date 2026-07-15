import { useState } from 'react';

// ─── LazyImage ────────────────────────────────────────────────────────────────
// Bandwidth- and jank-friendly image element for media served from the
// S3-compatible storage buckets:
//   * loading="lazy" + decoding="async" so off-screen media isn't fetched or
//     decoded until it approaches the viewport.
//   * Optional thumbnailUrl → progressive "blur-up": the tiny thumbnail paints
//     instantly (and is itself lazy/cached), then the full image fades in.
//   * Intrinsic width/height → a reserved aspect-ratio box, so the image
//     causes zero layout shift while it loads.
//   * Static bucket URLs are immutable, so the browser/CDN cache them
//     aggressively across sessions with no extra work here.

interface LazyImageProps {
  src: string;
  thumbnailUrl?: string | null;
  alt?: string;
  width?: number | null;
  height?: number | null;
  objectFit?: 'cover' | 'contain';
  rounded?: number | string;
  fallbackIcon?: string;
  style?: React.CSSProperties;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}

export function LazyImage({
  src, thumbnailUrl, alt = '', width, height,
  objectFit = 'cover', rounded, fallbackIcon = '🎉', style, className, onClick,
}: LazyImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const aspectRatio = width && height ? `${width} / ${height}` : undefined;
  const radius = rounded != null ? (typeof rounded === 'number' ? `${rounded}px` : rounded) : undefined;

  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        position: 'relative',
        overflow: 'hidden',
        aspectRatio,
        borderRadius: radius,
        background: 'linear-gradient(135deg,#1e1040 0%,#0f172a 100%)',
        ...style,
      }}
    >
      {thumbnailUrl && !loaded && !failed && (
        <img
          src={thumbnailUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit, filter: 'blur(14px)', transform: 'scale(1.08)' }}
        />
      )}

      {!failed && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            objectFit,
            display: 'block',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 0.4s ease',
          }}
        />
      )}

      {failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px' }}>
          {fallbackIcon}
        </div>
      )}
    </div>
  );
}
