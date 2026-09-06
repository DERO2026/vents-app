import { VentsLogo } from './VentsLogo';
import { appVersionLabel } from '../../lib/appVersion';

interface WelcomeScreenProps {
  onGetStarted: () => void;
  onSignIn: () => void;
  onPickState?: () => void;
  onBrowseGuest?: () => void;
}

const STACK_CARDS = [
  {
    src: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&fit=crop&crop=center',
    title: 'Services',
    subtitle: 'Beauty, home, photo and more',
    rotate: -9,
    top: 26,
    side: 'left' as const,
  },
  {
    src: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=600&fit=crop&crop=center',
    title: 'Experiences',
    subtitle: 'Discover, connect and enjoy',
    rotate: 8,
    top: 34,
    side: 'right' as const,
  },
  {
    src: 'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=700&fit=crop&crop=center',
    title: 'Events',
    subtitle: 'Concerts, parties, festivals and more',
    rotate: 0,
    top: 0,
    side: 'center' as const,
  },
];

export function WelcomeScreen({ onGetStarted, onSignIn, onPickState: _onPickState, onBrowseGuest }: WelcomeScreenProps) {
  return (
    <div
      style={{
        background: '#08050F',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        color: '#F0F0FF',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 420px 300px at 20% 5%, rgba(123,47,190,0.10) 0%, transparent 60%)', pointerEvents: 'none' }} />

      {/* Header */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'calc(20px + env(safe-area-inset-top)) 24px 0', flexShrink: 0 }}>
        <VentsLogo size={30} />
      </div>

      <div style={{ position: 'relative', padding: '14px 24px 0', flexShrink: 0, textAlign: 'center' }}>
        <span style={{ color: '#A97FD4', fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em' }}>EVENTS &middot; SERVICES &middot; REAL EXPERIENCES</span>
      </div>

      <div style={{ position: 'relative', padding: '12px 24px 0', flexShrink: 0, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h1 style={{ margin: 0, color: '#FFFFFF', fontSize: '30px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', lineHeight: 1.16, letterSpacing: '-0.01em' }}>
          More Than Events.
          <br />
          <span style={{ color: '#A855F7' }}>Real Experiences.</span>
        </h1>
        <p style={{ margin: '12px 0 0', color: '#9CA0BC', fontSize: '13.5px', lineHeight: 1.6, maxWidth: '280px' }}>
          Find events, book trusted services, and make it happen — all in one app.
        </p>
      </div>

      {/* Phone stack visual */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, margin: '18px 0 0' }}>
        {STACK_CARDS.map(card => (
          <div
            key={card.title}
            style={{
              position: 'absolute',
              top: `${card.top}px`,
              left: card.side === 'left' ? '26px' : card.side === 'center' ? '50%' : undefined,
              right: card.side === 'right' ? '22px' : undefined,
              transform: card.side === 'center' ? `translateX(-50%) rotate(${card.rotate}deg)` : `rotate(${card.rotate}deg)`,
              width: card.side === 'center' ? '172px' : '150px',
              height: card.side === 'center' ? '246px' : card.side === 'left' ? '220px' : '210px',
              borderRadius: card.side === 'center' ? '22px' : '20px',
              overflow: 'hidden',
              border: card.side === 'center' ? '1px solid rgba(168,85,247,0.22)' : '1px solid rgba(255,255,255,0.08)',
              boxShadow: card.side === 'center' ? '0 20px 40px rgba(88,28,135,0.28)' : '0 16px 30px rgba(0,0,0,0.35)',
              zIndex: card.side === 'center' ? 2 : 1,
            }}
          >
            <img src={card.src} alt={card.title} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, transparent 45%, rgba(0,0,0,0.85) 100%)' }} />
            <div style={{ position: 'absolute', left: '14px', right: '14px', bottom: '16px' }}>
              <p style={{ margin: 0, color: '#FFFFFF', fontSize: card.side === 'center' ? '15px' : '13px', fontWeight: 700, fontFamily: card.side === 'center' ? 'Space Grotesk, sans-serif' : undefined, textShadow: '0 1px 6px rgba(0,0,0,0.6)' }}>{card.title}</p>
              <p style={{ margin: '4px 0 0', color: '#C4C9E0', fontSize: '9.5px', lineHeight: 1.4, textShadow: '0 1px 6px rgba(0,0,0,0.6)' }}>{card.subtitle}</p>
            </div>
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', gap: '5px', padding: '12px 0 0', flexShrink: 0 }}>
        <div style={{ width: '16px', height: '5px', borderRadius: '3px', background: '#A855F7' }} />
        <div style={{ width: '5px', height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.18)' }} />
        <div style={{ width: '5px', height: '5px', borderRadius: '3px', background: 'rgba(255,255,255,0.18)' }} />
      </div>

      {/* Actions */}
      <div style={{ position: 'relative', padding: '16px 24px calc(24px + env(safe-area-inset-bottom))', flexShrink: 0 }}>
        <button
          onClick={onGetStarted}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, #7B2FBE, #5B3FCB)',
            border: 'none',
            borderRadius: '100px',
            padding: '15px 26px',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 8px 20px rgba(88,42,143,0.32)',
            marginBottom: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>Get Started</span>
          <span style={{ fontSize: '18px' }}>→</span>
        </button>

        <button
          onClick={onSignIn}
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '100px',
            padding: '13px 26px',
            color: '#C4C9E0',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            textAlign: 'center',
            marginBottom: '16px',
          }}
        >
          Sign in
        </button>

        {onBrowseGuest && (
          <button
            onClick={onBrowseGuest}
            style={{
              width: '100%',
              background: 'none',
              border: 'none',
              padding: '10px 26px',
              color: '#7C8199',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'center',
              marginBottom: '10px',
            }}
          >
            Browse as guest
          </button>
        )}

        <p style={{ textAlign: 'center', color: '#3A3D52', fontSize: '10px', margin: 0 }}>
          {appVersionLabel()}
        </p>
      </div>
    </div>
  );
}
