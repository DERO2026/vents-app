import { useEffect, useState } from 'react';
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

export function VentsAiOrb({ onOpen, userId }: { onOpen: () => void; userId?: string | null }) {
  const storageKey = `vents_ai_orb_seen_${userId || 'guest'}`;
  const [showTooltip, setShowTooltip] = useState(false);

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

  const dismiss = () => {
    setShowTooltip(false);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // localStorage unavailable (private window etc.) -- non-fatal, the
      // tooltip just reappears next launch, which is fine for this nicety.
    }
  };

  return (
    <div
      style={{ position: 'fixed', bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))', right: 16, zIndex: 60 }}
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
        onClick={() => {
          dismiss();
          onOpen();
        }}
        style={{
          width: 54,
          height: 54,
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
        }}
      >
        <span style={{ fontSize: 21, color: '#fff' }}>✦</span>
      </button>
    </div>
  );
}
