import { useRef, useState } from 'react';

const EDGE_ZONE_PX = 24;
const COMMIT_THRESHOLD_PX = 100;

// iOS-style edge-swipe-to-go-back, generalized to also feel right on Android.
// Only engages when the drag STARTS within EDGE_ZONE_PX of the left edge —
// this is what keeps it from stealing horizontal scroll, carousels, and
// lightbox swipes elsewhere on screen, which never start flush against the
// edge. Also bails if the gesture turns out to be more vertical than
// horizontal (a diagonal touch near the edge shouldn't hijack a vertical
// scroll/pull-to-refresh already in progress there).
export function useSwipeBack(canGoBack: boolean, onBack: () => void) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const engagedRef = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!canGoBack) return;
    const t = e.touches[0];
    if (t.clientX > EDGE_ZONE_PX) return;
    startRef.current = { x: t.clientX, y: t.clientY };
    engagedRef.current = false;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!startRef.current) return;
    const t = e.touches[0];
    const dx = t.clientX - startRef.current.x;
    const dy = t.clientY - startRef.current.y;
    if (!engagedRef.current) {
      // Not enough movement yet to tell horizontal from vertical — wait.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // A more-vertical gesture near the edge is a scroll, not a back-swipe —
      // stop tracking for the rest of this touch.
      if (Math.abs(dy) > Math.abs(dx)) { startRef.current = null; return; }
      engagedRef.current = true;
      setDragging(true);
    }
    if (dx > 0) setDragX(dx);
  };

  const onTouchEnd = () => {
    if (!engagedRef.current) { startRef.current = null; return; }
    startRef.current = null;
    engagedRef.current = false;
    setDragging(false);
    if (dragX > COMMIT_THRESHOLD_PX) {
      onBack();
    }
    setDragX(0);
  };

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    style: {
      transform: dragX ? `translateX(${dragX}px)` : undefined,
      transition: dragging ? 'none' : 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
    } as React.CSSProperties,
  };
}
