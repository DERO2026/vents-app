import type { ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { VentsLogo } from './VentsLogo';
import { ventsColors, ventsTypography } from '../../lib/ventsDesignTokens';

// Official, live VENTS store listings -- never fabricate or alter these.
const APP_STORE_URL = 'https://apps.apple.com/ng/app/vents-events/id6802584284';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.getvents.app';

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
        // iPad portrait (verified at 820x1180pt, the 11" Air M3 Apple's Oct
        // 2026 rejection reproduced on): this screen's real content is
        // shorter than the viewport, and with no justifyContent it all
        // top-pinned, leaving a large dead gap at the bottom -- exactly the
        // "excessive empty space" Apple flagged. Centering is a no-op on
        // phones (content already meets or exceeds the viewport there, so
        // there's no slack to redistribute) and fixes the real gap on
        // taller/tablet viewports without touching any card/button layout.
        justifyContent: 'center',
        overflow: 'hidden',
        position: 'relative',
        color: ventsColors.ink1,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: ventsColors.ambientGradient, opacity: 0.5, pointerEvents: 'none' }} />

      {/* Header.
          Top padding is a dvh-scaled clamp, not a fixed 48px, so the whole
          composition below it compresses together on a short viewport
          (Safari's address/tab bar chrome eats into 100dvh) instead of
          pushing the bottom actions (login/guest/store-badges) out of view
          or into .phone-frame's overflow:hidden clip. On a tall viewport
          the clamp settles at its upper bound, visually unchanged from the
          original fixed value -- desktop/tablet (routed through the same
          component at a taller effective height) are unaffected. */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'calc(clamp(16px, 5dvh, 40px) + env(safe-area-inset-top)) 24px 0', flexShrink: 0 }}>
        <VentsLogo size={86} />
      </div>

      {/* Handoff A1: single-color headline directly under the logo (no
          mono eyebrow line above it, no accent-colored second line) and one
          subtitle line, matching the design's exact copy.
          Top padding scaled the same way as the header above, for the same
          reason -- see that comment. */}
      <div style={{ position: 'relative', padding: 'clamp(16px, 3dvh, 28px) 24px 0', flexShrink: 0, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
      <div style={{ position: 'relative', flex: 1, minHeight: 'clamp(160px, 24dvh, 236px)', maxHeight: '260px', margin: 'clamp(10px, 2.5dvh, 20px) 0 0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
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
                  position: 'absolute', left: '14px', right: '14px', top: '16px',
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
      <div style={{ position: 'relative', padding: 'clamp(12px, 2.5dvh, 24px) 24px calc(clamp(12px, 2.5dvh, 24px) + env(safe-area-inset-bottom))', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(10px, 2dvh, 16px)' }}>
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

        {/* Download CTA -- web only. Inside the native app shell the person
            already has VENTS installed, so this would be redundant noise. */}
        {!Capacitor.isNativePlatform() && (
          <div style={{ width: '100%', marginTop: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ flex: 1, height: '1px', background: ventsColors.divider }} />
              <span style={{ fontFamily: ventsTypography.fontMono, fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: ventsColors.ink3, whiteSpace: 'nowrap' }}>
                Get the app
              </span>
              <div style={{ flex: 1, height: '1px', background: ventsColors.divider }} />
            </div>
            <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
              <StoreBadge href={APP_STORE_URL} label="Download on the" store="App Store" icon={<AppleIcon />} />
              <StoreBadge href={PLAY_STORE_URL} label="GET IT ON" store="Google Play" icon={<PlayIcon />} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StoreBadge({ href, label, store, icon }: { href: string; label: string; store: string; icon: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        height: '48px',
        borderRadius: '12px',
        background: ventsColors.glassBg,
        border: `1px solid ${ventsColors.glassBorder}`,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        color: ventsColors.white,
        textDecoration: 'none',
      }}
    >
      {icon}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span style={{ fontSize: '8px', fontWeight: 500, color: ventsColors.ink3, letterSpacing: '0.02em' }}>{label}</span>
        <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: ventsTypography.fontBody }}>{store}</span>
      </span>
    </a>
  );
}

function AppleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        fill={ventsColors.white}
        d="M16.365 1.43c0 1.14-.468 2.217-1.17 3.012-.792.903-2.094 1.602-3.189 1.512-.144-1.098.414-2.25 1.116-2.97.792-.837 2.142-1.473 3.243-1.554Zm3.858 16.302c-.468 1.08-.693 1.566-1.296 2.52-.84 1.332-2.025 2.994-3.492 3.012-1.302.018-1.638-.846-3.402-.837-1.764.009-2.133.855-3.438.837-1.467-.018-2.589-1.512-3.429-2.844C2.985 17.235 2.532 13.212 3.822 11.07c.903-1.512 2.331-2.394 3.675-2.394 1.368 0 2.229.837 3.357.837 1.095 0 1.764-.837 3.357-.837 1.197 0 2.466.654 3.369 1.782-2.961 1.62-2.481 5.841.643 7.272Z"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="#00D9FF" d="M3.6 2.5 14.5 12 3.6 21.5c-.3-.2-.5-.5-.5-1V3.5c0-.5.2-.8.5-1Z" />
      <path fill="#FFCA28" d="M14.5 12 3.6 2.5c.2-.1.5-.1.8.1l9.5 5.5-0.4 1 1-1Z" />
      <path fill="#FF3D57" d="M18.8 9.4 14.5 12l4.3 2.6c.9-.5 1.5-1.1 1.5-1.8v-1.6c0-.7-.6-1.3-1.5-1.8Z" />
      <path fill="#4CAF50" d="M3.6 21.5c.2.1.5.1.8-.1l9.5-5.5-4.3-2.6-6 7.2c0 .4.2.8.5 1Z" />
    </svg>
  );
}
