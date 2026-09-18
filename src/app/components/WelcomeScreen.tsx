import { VentsLogo } from './VentsLogo';
import { ventsColors, ventsTypography } from '../../lib/ventsDesignTokens';

interface WelcomeScreenProps {
  onGetStarted: () => void;
  onSignIn: () => void;
  onPickState?: () => void;
  onBrowseGuest?: () => void;
}

// Handoff A1 (LandingScreen): side cards carry only a single JetBrains Mono
// uppercase caption (no subtitle line); the center card gets a dark-glass
// "EVENTS" pill instead of a title. Sizes/rotation/position match the
// design's 172x224 side / 196x262 center stack.
const STACK_CARDS = [
  {
    src: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&fit=crop&crop=center',
    caption: 'Services',
    rotate: -10,
    // Was 20px lower than the center card, which pushed its caption
    // further into the bottom fade and made it read less clearly than the
    // center card's "EVENTS" pill -- moved flush with center's top so
    // Services/Experiences read as clearly as Events.
    top: 0,
    side: 'left' as const,
  },
  {
    src: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=600&fit=crop&crop=center',
    caption: 'Experiences',
    rotate: 10,
    top: 0,
    side: 'right' as const,
  },
  {
    src: 'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=700&fit=crop&crop=center',
    caption: null,
    rotate: 0,
    top: 0,
    side: 'center' as const,
  },
];

export function WelcomeScreen({ onGetStarted, onSignIn, onPickState: _onPickState, onBrowseGuest }: WelcomeScreenProps) {
  return (
    <div
      style={{
        background: ventsColors.bg,
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        color: ventsColors.ink1,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: ventsColors.ambientGradient, opacity: 0.5, pointerEvents: 'none' }} />

      {/* Header */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'calc(48px + env(safe-area-inset-top)) 24px 0', flexShrink: 0 }}>
        <VentsLogo size={86} />
      </div>

      {/* Handoff A1: single-color headline directly under the logo (no
          mono eyebrow line above it, no accent-colored second line) and one
          subtitle line, matching the design's exact copy. */}
      <div style={{ position: 'relative', padding: '34px 24px 0', flexShrink: 0, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h1 style={{ margin: 0, color: ventsColors.white, fontSize: '34px', fontWeight: 800, fontFamily: ventsTypography.fontBody, lineHeight: 1.12, letterSpacing: '-0.035em', maxWidth: '310px' }}>
          More Than Events.
          <br />
          Real Experiences.
        </h1>
        <p style={{ margin: '14px 0 0', color: ventsColors.ink2, fontSize: '15px', lineHeight: 1.55, maxWidth: '290px' }}>
          Tickets, services and the nights worth remembering — in one place.
        </p>
      </div>

      {/* Phone stack visual -- handoff A1: 172x224 side cards (rotated
          ±10deg) behind a 196x262 center card, mono uppercase captions
          instead of title+subtitle pairs. */}
      <div style={{ position: 'relative', flex: 1, minHeight: '236px', maxHeight: '260px', margin: '24px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {STACK_CARDS.map(card => (
          <div
            key={card.caption ?? 'center'}
            style={{
              position: 'absolute',
              top: `${card.top}px`,
              // Side cards get a small inward inset (not flush against the
              // true screen edge) -- rotating a ±10deg box widens its
              // rendered footprint by ~16-20px beyond its own pre-rotation
              // edge, which a flush left:0/right:0 anchor pushed straight
              // past the container's clipping boundary, truncating the
              // caption text unevenly on each side ("Experiences" showing
              // only "ENCES"). The inset gives that rotation spill room to
              // stay inside the visible/clipped area.
              left: card.side === 'left' ? '20px' : card.side === 'center' ? '50%' : undefined,
              right: card.side === 'right' ? '20px' : undefined,
              transform: card.side === 'center' ? `translateX(-50%) rotate(${card.rotate}deg)` : `rotate(${card.rotate}deg)`,
              width: card.side === 'center' ? '176px' : '154px',
              height: card.side === 'center' ? '236px' : '200px',
              borderRadius: '22px',
              overflow: 'hidden',
              border: card.side === 'center' ? '1px solid rgba(183,155,255,0.3)' : '1px solid rgba(255,255,255,0.1)',
              boxShadow: card.side === 'center'
                ? '0 34px 70px -20px rgba(0,0,0,0.95), 0 0 60px -20px rgba(142,92,247,0.6)'
                : '0 24px 50px -18px rgba(0,0,0,0.9)',
              zIndex: card.side === 'center' ? 3 : 1,
            }}
          >
            <img src={card.src} alt={card.caption ?? 'Events'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, transparent 45%, rgba(0,0,0,0.85) 100%)' }} />
            {card.side === 'center' ? (
              <>
                <span style={{ position: 'absolute', top: '16px', left: '16px', fontFamily: ventsTypography.fontMono, fontSize: '9px', fontWeight: 700, letterSpacing: '0.14em', padding: '5px 9px', borderRadius: '7px', background: 'rgba(8,7,12,0.55)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.16)', color: '#fff' }}>
                  EVENTS
                </span>
              </>
            ) : (
              // The higher z-index center card overlaps the INNER half of
              // each side card (they're stacked, not side-by-side). Text
              // starting flush against that inner edge renders mostly
              // underneath the center card -- "Experiences" showed only its
              // last few letters because it started right where the overlap
              // begins. Anchoring each caption to its card's OUTER edge
              // (left card -> left-aligned, right card -> right-aligned)
              // keeps the whole word in the clear, unobstructed area.
              <span
                style={{
                  position: 'absolute', left: '14px', right: '14px', bottom: '14px',
                  fontFamily: ventsTypography.fontMono, fontSize: '10px', fontWeight: 500,
                  letterSpacing: '0.16em', textTransform: 'uppercase', color: 'rgba(237,234,245,0.7)',
                  textShadow: '0 1px 6px rgba(0,0,0,0.6)',
                  textAlign: card.side === 'right' ? 'right' : 'left',
                }}
              >
                {card.caption}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Actions -- handoff A1: single primary CTA + a plain "Already have
          an account? Log in" line (no second full-width Sign In button, no
          pagination dots, no version footer). Guest browsing has no design
          slot here either, but the entry point stays reachable as a small
          understated link rather than being dropped outright. */}
      <div style={{ position: 'relative', padding: '24px 24px calc(24px + env(safe-area-inset-bottom))', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
        <button
          onClick={onGetStarted}
          style={{
            width: '100%',
            height: '56px',
            background: ventsColors.accent,
            border: 'none',
            borderRadius: '16px',
            color: ventsColors.white,
            fontSize: '17px',
            fontWeight: 700,
            fontFamily: ventsTypography.fontBody,
            cursor: 'pointer',
            boxShadow: '0 14px 40px -14px rgba(142,92,247,1)',
          }}
        >
          Get Started
        </button>

        <p style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: ventsColors.ink2, textAlign: 'center' }}>
          Already have an account?{' '}
          <span onClick={onSignIn} style={{ color: '#B79BFF', fontWeight: 700, cursor: 'pointer' }}>Log in</span>
        </p>

        {onBrowseGuest && (
          <span onClick={onBrowseGuest} style={{ fontSize: '13px', fontWeight: 600, color: '#7C8199', cursor: 'pointer' }}>
            Browse as guest
          </span>
        )}
      </div>
    </div>
  );
}
