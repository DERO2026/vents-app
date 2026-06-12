import { Zap, MapPin, Ticket, ChevronDown } from 'lucide-react';
import { VentsLogo } from './VentsLogo';

interface WelcomeScreenProps {
  onGetStarted: () => void;
  onSignIn: () => void;
  onPickState?: () => void;
}

export function WelcomeScreen({ onGetStarted, onSignIn, onPickState }: WelcomeScreenProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(165deg, #100018 0%, #060A12 45%, #0A0A1A 100%)',
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
          0%   { box-shadow: 0 8px 36px rgba(123,47,190,0.6), 0 0 0 0 rgba(168,85,247,0.5); }
          50%  { box-shadow: 0 8px 36px rgba(123,47,190,0.8), 0 0 0 14px rgba(168,85,247,0); }
          100% { box-shadow: 0 8px 36px rgba(123,47,190,0.6), 0 0 0 0 rgba(168,85,247,0); }
        }
        @keyframes arrowBounce {
          0%, 100% { transform: translateX(0); }
          50%       { transform: translateX(5px); }
        }
      `}</style>

      {/* Background glow orbs */}
      <div style={{ position: 'absolute', width: '420px', height: '420px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(124,58,237,0.14) 0%, transparent 70%)', top: '-140px', right: '-140px', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', width: '280px', height: '280px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(79,70,229,0.1) 0%, transparent 70%)', bottom: '80px', left: '-100px', pointerEvents: 'none' }} />

      {/* Hero image */}
      <div style={{ position: 'relative', height: '310px', flexShrink: 0 }}>
        <img
          src="https://images.unsplash.com/photo-1661335908621-3efb9761bbaf?w=800&fit=crop&crop=center"
          alt="Events in Nigeria"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(8,0,20,0.35) 0%, rgba(8,0,20,0.0) 35%, rgba(6,10,18,1) 95%)' }} />
        <div style={{ position: 'absolute', top: '28px', left: '24px' }}>
          <VentsLogo size={38} />
        </div>
        {/* Attendee pill */}
        <div style={{ position: 'absolute', bottom: '28px', left: '24px', background: 'rgba(10,10,25,0.75)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '50px', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex' }}>
            {['#EC4899', '#A855F7', '#3B82F6'].map((c, i) => (
              <div key={i} style={{ width: '22px', height: '22px', borderRadius: '50%', background: c, border: '2px solid #0A0A1A', marginLeft: i > 0 ? '-8px' : '0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', color: '#fff', fontWeight: 700 }}>
                {['C', 'E', 'T'][i]}
              </div>
            ))}
          </div>
          <span style={{ color: '#C4C9E0', fontSize: '12px', fontWeight: 500 }}>
            <span style={{ color: '#A855F7', fontWeight: 700 }}>50,000+</span> attendees this month
          </span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
        <h1 style={{ color: '#FFFFFF', fontSize: '26px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', lineHeight: 1.25, marginBottom: '8px' }}>
          Discover Nigeria's
          <br />
          <span style={{ color: '#A855F7' }}>Best Events</span>
        </h1>

        <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '13px', lineHeight: 1.6, marginBottom: '20px' }}>
          Book tickets to concerts, tech summits, food festivals and more — all across Nigeria.
        </p>

        {/* Feature chips */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '22px' }}>
          <div
            onClick={onPickState}
            style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: '10px', padding: '8px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flex: 1, cursor: onPickState ? 'pointer' : 'default' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
              <MapPin size={12} color="#A855F7" />
              <ChevronDown size={9} color="#A855F7" />
            </div>
            <span style={{ color: '#C4C9E0', fontSize: '9px', textAlign: 'center', fontWeight: 500, lineHeight: 1.3 }}>15 States</span>
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

        {/* TAP indicator above button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginBottom: '10px' }}>
          <div style={{ height: '1px', flex: 1, background: 'rgba(168,85,247,0.2)' }} />
          <span style={{ color: 'rgba(168,85,247,0.7)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em' }}>TAP TO BEGIN</span>
          <div style={{ height: '1px', flex: 1, background: 'rgba(168,85,247,0.2)' }} />
        </div>

        {/* Get Started — main CTA */}
        <button
          onClick={onGetStarted}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, #8B3FD9 0%, #5B4FEA 100%)',
            border: '1.5px solid rgba(168,85,247,0.4)',
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
          <span style={{ color: '#A78BFA', fontWeight: 600 }}>Sign in</span>
        </button>
      </div>
    </div>
  );
}
