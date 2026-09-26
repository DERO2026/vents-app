import { useEffect, useState } from 'react';

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
    if (!seen) setShowTooltip(true);
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
      style={{ position: 'fixed', bottom: 96, right: 16, zIndex: 60 }}
      data-testid="vents-ai-orb"
    >
      <style>{`@keyframes ventsAiPulseGlow{0%,100%{box-shadow:0 0 0 0 rgba(163,92,255,.45);}50%{box-shadow:0 0 0 10px rgba(163,92,255,0);}}`}</style>
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: 64,
            right: 0,
            whiteSpace: 'nowrap',
            background: '#161020',
            border: '1px solid #2a2438',
            borderRadius: 10,
            padding: '8px 12px',
            fontSize: 12,
            fontWeight: 600,
            color: '#e4d4ff',
            boxShadow: '0 8px 20px rgba(0,0,0,.4)',
          }}
        >
          Ask VENTS AI anything
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
