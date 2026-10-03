import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';

// Persistent floating orb entry point for VENTS AI, per design-export/
// "VENTS AI.dc.html"'s ENTRY view (bottom:96px;right:16px so it sits above
// the 4-tab BottomNav, not on top of it; 54x54 circle, purple gradient,
// pulseGlow animation, "✦" glyph). App.tsx renders this on top of
// Home/Discover/Bookings only -- see src/app/lib/ventsAiOrbScreens.ts.
//
// First-launch tooltip: the export calls for "gentle pulse + one-time
// tooltip … After first tap it settles to a static icon." This repo has no
// backend flag or Context for this kind of one-off UI nicety, so it's a
// plain localStorage flag, scoped per user id the same way
// `vents_was_organizer_${id}` already is elsewhere in App.tsx.
//
// The tooltip is a brief discovery NUDGE, not a standing banner: it marks
// itself "seen" the moment it's shown (not only once tapped) so navigating
// away from an orb-bearing screen and back -- which unmounts/remounts this
// component -- doesn't resurrect it, and it also auto-hides itself after a
// few seconds even if the user never taps the orb. Either path is enough to
// satisfy "shown at least once"; together they stop it from repeatedly
// interrupting navigation while still giving every user a first look.
const TOOLTIP_AUTO_HIDE_MS = 4000;

const GRADIENT = 'linear-gradient(135deg,#c084fc,#7c3aed)';
const ORB_SIZE = 54;
// A plain tap and the start of a drag look identical for the first few
// pixels -- this is the threshold past which a pointer-down+move is
// treated as a drag rather than a tap, so the orb still opens VENTS AI on
// a normal tap instead of every tap being swallowed as a zero-distance drag.
const DRAG_THRESHOLD_PX = 6;

interface OrbPos { x: number; y: number; }

// Draggable position is a device-local display preference (same
// per-user-id localStorage pattern as the tooltip-seen flag above), not
// account data -- never synced, never round-tripped through the backend.
function loadOrbPos(key: string): OrbPos | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveOrbPos(key: string, pos: OrbPos) {
  try {
    localStorage.setItem(key, JSON.stringify(pos));
  } catch {
    // private browsing / storage disabled -- the orb still drags for this
    // session, it just won't remember the new spot next launch.
  }
}

// Keeps the orb fully on-screen (e.g. after an orientation change, or a
// position saved on a larger viewport than the one it's now rendering in)
// rather than letting it drift off the visible edge where it could become
// unreachable.
function clampPos(pos: OrbPos): OrbPos {
  const maxX = Math.max(0, window.innerWidth - ORB_SIZE);
  const maxY = Math.max(0, window.innerHeight - ORB_SIZE);
  return { x: Math.min(Math.max(pos.x, 0), maxX), y: Math.min(Math.max(pos.y, 0), maxY) };
}

export function VentsAiOrb({ onOpen, userId }: { onOpen: () => void; userId?: string | null }) {
  const storageKey = `vents_ai_orb_seen_${userId || 'guest'}`;
  const posKey = `vents_ai_orb_pos_${userId || 'guest'}`;
  const [showTooltip, setShowTooltip] = useState(false);
  const [pos, setPos] = useState<OrbPos | null>(() => loadOrbPos(posKey));
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Refs, not state: drag bookkeeping must never itself trigger a
  // re-render (only the actual position does), and handlePointerUp/onClick
  // need the latest "did this gesture move" answer synchronously, which a
  // state setter's async batching can't guarantee in time for the click
  // that immediately follows pointerup.
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(storageKey) === '1';
    } catch {
      seen = false;
    }
    if (seen) return;

    setShowTooltip(true);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // localStorage unavailable (private window etc.) -- non-fatal, the
      // tooltip just reappears next mount, which is fine for this nicety.
    }

    const timer = window.setTimeout(() => setShowTooltip(false), TOOLTIP_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [storageKey]);

  // Re-clamp a saved/dragged position on resize/orientation change so the
  // orb never ends up off-screen (e.g. rotating a phone, or Safari's
  // address bar changing the usable viewport height mid-session). Only
  // applies once the orb has actually been moved -- the default
  // bottom/right CSS anchor already tracks viewport changes on its own.
  useEffect(() => {
    function onResize() {
      setPos(prev => (prev ? clampPos(prev) : prev));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const dismiss = () => {
    setShowTooltip(false);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // localStorage unavailable (private window etc.) -- non-fatal, the
      // tooltip just reappears next launch, which is fine for this nicety.
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const origX = pos ? pos.x : (rect?.left ?? 0);
    const origY = pos ? pos.y : (rect?.top ?? 0);
    dragStartRef.current = { pointerX: e.clientX, pointerY: e.clientY, origX, origY };
    movedRef.current = false;
    draggingRef.current = true;
    // setPointerCapture keeps move/up events firing on this element even if
    // the finger/cursor leaves it mid-drag (a fast drag easily outruns a
    // 54px circle) -- guarded since it's unsupported in jsdom (this
    // project's test environment), unlike every real target platform
    // (Chrome/Safari/Capacitor's native WebViews all support it).
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported in this environment */ }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current || !dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.pointerX;
    const dy = e.clientY - dragStartRef.current.pointerY;
    if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    movedRef.current = true;
    setPos(clampPos({ x: dragStartRef.current.origX + dx, y: dragStartRef.current.origY + dy }));
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (movedRef.current && dragStartRef.current) {
      const dx = e.clientX - dragStartRef.current.pointerX;
      const dy = e.clientY - dragStartRef.current.pointerY;
      saveOrbPos(posKey, clampPos({ x: dragStartRef.current.origX + dx, y: dragStartRef.current.origY + dy }));
    }
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  return (
    <div
      ref={wrapperRef}
      style={pos
        ? { position: 'fixed', left: `${pos.x}px`, top: `${pos.y}px`, zIndex: 60 }
        : { position: 'fixed', bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))', right: 16, zIndex: 60 }}
      data-testid="vents-ai-orb"
    >
      <style>{`@keyframes ventsAiPulseGlow{0%,100%{box-shadow:0 0 0 0 rgba(163,92,255,.45);}50%{box-shadow:0 0 0 10px rgba(163,92,255,0);}}`}</style>
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: 64,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            whiteSpace: 'nowrap',
            background: '#161020',
            border: '1px solid #2a2438',
            borderRadius: 10,
            padding: '8px 8px 8px 12px',
            fontSize: 12,
            fontWeight: 600,
            color: '#e4d4ff',
            boxShadow: '0 8px 20px rgba(0,0,0,.4)',
          }}
        >
          <span>Ask VENTS AI anything</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              // Dismiss only -- must not also open VENTS AI, since it sits
              // inside the same tappable region as the orb below it.
              e.stopPropagation();
              dismiss();
            }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#8B8FA8', flexShrink: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <button
        type="button"
        aria-label="Open VENTS AI"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={() => {
          // A drag ends with the browser firing a click on release -- swallow
          // it here so dragging the orb elsewhere on screen never also opens
          // VENTS AI. A plain tap (no intervening pointermove past the
          // threshold) leaves movedRef false and opens as normal.
          if (movedRef.current) {
            movedRef.current = false;
            return;
          }
          dismiss();
          onOpen();
        }}
        style={{
          width: ORB_SIZE,
          height: ORB_SIZE,
          borderRadius: '50%',
          background: GRADIENT,
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 6px 24px rgba(124,58,237,.6)',
          cursor: 'pointer',
          animation: showTooltip ? 'ventsAiPulseGlow 2.4s infinite' : 'none',
          padding: 0,
          // Without this, mobile browsers/WebViews treat a finger-down on
          // the orb as the start of a page-scroll gesture, which both
          // steals the drag and scrolls the screen underneath it.
          touchAction: 'none',
        }}
      >
        <span style={{ fontSize: 21, color: '#fff' }}>✦</span>
      </button>
    </div>
  );
}
