import React from 'react';
import { EVENT_CARD_ASPECT_CSS } from '../../lib/eventCardAspect';

// The single image primitive shared by the event-card previews and available to
// card layouts. It renders a flyer in the canonical portrait (4:5) box with
// object-fit: cover — exactly how flyers appear on cards across the app — so a
// preview built from this is pixel-faithful to production. It intentionally does
// NOT change any card's outer dimensions; it only standardises the image box.
export function EventCardImage({
  src, radius = 16, style, dimmed = false,
}: {
  src?: string | null;
  radius?: number;
  style?: React.CSSProperties;
  dimmed?: boolean;
}) {
  return (
    <div
      style={{
        aspectRatio: EVENT_CARD_ASPECT_CSS,
        width: '100%',
        borderRadius: radius,
        overflow: 'hidden',
        background: '#0B0618',
        position: 'relative',
        ...style,
      }}
    >
      {src && (
        <img
          src={src}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', filter: dimmed ? 'brightness(0.9)' : 'none' }}
        />
      )}
    </div>
  );
}
