import type { CSSProperties } from 'react';

// The ONLY overlay allowed on an event flyer / cover image: a bottom-only
// gradient that starts fully transparent and fades into the VENTS
// background (#060A14) behind the text that sits on the image. The flyer
// above stays untouched and bright.
//
// It replaces the flat dark bands (rgba(0,0,0,0.65-0.85) over the lower
// 40-60% of the image) that commit 407ae10 ("Remove all gradients") put on
// every flyer, which greyed out half of each image. A regression test
// (flyerScrim.test.ts) fails if any image gets a flat dark band again.
export function flyerScrim(heightPct = 40): CSSProperties {
  const h = Math.max(15, Math.min(60, heightPct));
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: `${h}%`,
    pointerEvents: 'none',
    background: 'linear-gradient(to bottom, rgba(6,10,20,0) 0%, rgba(6,10,20,0.5) 45%, rgba(6,10,20,0.88) 100%)',
  };
}
