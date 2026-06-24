import { useState, useEffect } from 'react';
import { Zap, Ticket, Globe } from 'lucide-react';
import { VentsLogo } from './VentsLogo';

interface WelcomeScreenProps {
  onGetStarted: () => void;
  onSignIn: () => void;
  onPickState?: () => void;
}

const SLIDES = [
  'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&fit=crop&crop=center',
  'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800&fit=crop&crop=center',
  'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=800&fit=crop&crop=center',
  'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&fit=crop&crop=center',
];

export function WelcomeScreen({ onGetStarted, onSignIn, onPickState }: WelcomeScreenProps) {
  const [slide, setSlide] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setSlide(s => (s + 1) % SLIDES.length);
        setFading(false);
      }, 400);
    }, 3200);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      style={{
        background: '#000000',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <style>{`
        @keyframes ctaPulse {
          0%   { box-shadow: 0 8px 36px rgba(168,85,247,0.6), 0 0 0 0 rgba(168,85,247,0.5); }
          50%  { box-shadow: 0 8px 36px rgba(168,85,247,0.9), 0 0 0 16px rgba(168,85,247,0); }
          100% { box-shadow: 0 8px 36px rgba(168,85,247,0.6), 0 0 0 0 rgba(168,85,247,0); }
        }
        @keyframes arrowBounce {
          0%, 100% { transform: translateX(0); }
          50%       { transform: translateX(0); }
        }
        @keyframes neonPulse {
          0%, 100% { opacity: 0.7; }
          50%       { opacity: 1; }
        }
      `}</style>

      {/* Background glow orbs */}
      <div style={{ position: 'absolute', width: '350px', height: '350px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,85,247,0.18) 0%, transparent 70%)', top: '-120px', right: '-120px', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', width: '250px', height: '250px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,229,255,0.08) 0%, transparent 70%)', bottom: '100px', left: '-80px', pointerEvents: 'none' }} />

      {/* Hero slideshow */}
      <div style={{ position: 'relative', height: 'calc(310px + env(safe-area-inset-top))', flexShrink: 0 }}>
        {/* Slide images — cross-fade */}
        {SLIDES.map((src, idx) => (
          <img
            key={src}
            src={src}
            alt="Events"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: idx === slide ? (fading ? 0 : 1) : 0,
              transition: 'opacity 0.4s ease',
            }}
          />
        ))}
        {/* Dark overlay */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.0) 35%, rgba(0,0,0,0.95) 95%)' }} />

        {/* Logo */}
        <div style={{ position: 'absolute', top: 'calc(28px + env(safe-area-inset-top))', left: '24px', zIndex: 2 }}>
          <VentsLogo size={38} />
        </div>

        {/* Slide indicators */}
        <div style={{ position: 'absolute', bottom: '40px', right: '24px', display: 'flex', gap: '5px', zIndex: 2 }}>
          {SLIDES.map((_, i) => (
            <div key={i} style={{ width: i === slide ? '16px' : '5px', height: '5px', borderRadius: '3px', background: i === slide ? '#A855F7' : 'rgba(255,255,255,0.3)', transition: 'all 0.3s ease' }} />
          ))}
        </div>

        {/* Welcome pill */}
        <div style={{ position: 'absolute', bottom: '28px', left: '24px', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(12px)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: '50px', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', zIndex: 2 }}>
          <span style={{ fontSize: '14px' }}>🎉</span>
          <span style={{ color: '#C4C9E0', fontSize: '12px', fontWeight: 500 }}>
            Welcome to <span style={{ color: '#A855F7', fontWeight: 700 }}>Vents</span>
          </span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        <h1 style={{ color: '#FFFFFF', fontSize: '26px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', lineHeight: 1.25, marginBottom: '8px' }}>
          Discover Nigeria's
          <br />
          <span style={{ color: '#A855F7', textShadow: '0 0 20px rgba(168,85,247,0.5)' }}>Best Events</span>
        </h1>

        <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
          Book tickets to concerts, tech summits, food festivals and more — all across Nigeria.
        </p>

        {/* Feature chips */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '22px' }}>
          {/* All States chip */}
          <div
            style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: '10px', padding: '8px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 1, cursor: 'pointer', boxShadow: '0 0 12px rgba(168,85,247,0.15)' }}
          >
            <Globe size={12} color="#A855F7" />
            <span style={{ color: '#C4C9E0', fontSize: '9px', textAlign: 'center', fontWeight: 600, lineHeight: 1.3 }}>All States</span>
          </div>
          {[
            { icon: Zap, text: 'Instant booking' },
            { icon: Ticket, text: 'Digital tickets' },
          ].map(({ icon: Icon, text }) => (
            <div key={text} style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.15)', borderRadius: '10px', padding: '8px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 1 }}>
              <Icon size={12} color="#A855F7" />
              <span style={{ color: '#C4C9E0', fontSize: '9px', textAlign: 'center', fontWeight: 500, lineHeight: 1.3 }}>{text}</span>
            </div>
          ))}
        </div>

        {/* TAP indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginBottom: '10px' }}>
          <div style={{ height: '1px', flex: 1, background: 'rgba(168,85,247,0.2)' }} />
          <span style={{ color: 'rgba(168,85,247,0.8)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', animation: 'neonPulse 2s ease-in-out infinite' }}>TAP TO BEGIN</span>
          <div style={{ height: '1px', flex: 1, background: 'rgba(168,85,247,0.2)' }} />
        </div>

        {/* Get Started — liquid glass button */}
        <button
          onClick={onGetStarted}
          style={{
            width: '100%',
            background: 'rgba(168,85,247,0.15)',
            border: '1.5px solid rgba(168,85,247,0.5)',
            backdropFilter: 'blur(12px)',
            borderRadius: '18px',
            padding: '19px 24px',
            color: '#fff',
            fontSize: '20px',
            fontWeight: 900,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: 'pointer',
            animation: 'ctaPulse 2.4s ease-in-out infinite',
            marginBottom: '12px',
            letterSpacing: '0.01em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>Get Started</span>
          <span style={{ fontSize: '22px', animation: 'arrowBounce 1.2s ease-in-out infinite' }}>→</span>
        </button>

        {/* Sign in link */}
        <button
          onClick={onSignIn}
          style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.45)', fontSize: '14px', fontWeight: 400, cursor: 'pointer', padding: '4px', textAlign: 'center' }}
        >
          Already have an account?{' '}
          <span style={{ color: '#A855F7', fontWeight: 600 }}>Sign in</span>
        </button>

        {/* Footer */}
        <p style={{ textAlign: 'center', color: '#333', fontSize: '10px', marginTop: '12px' }}>
          VENTS v1.1.0 | © VENTS LTD
        </p>
      </div>
    </div>
  );
}
