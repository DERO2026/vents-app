import { ArrowLeft, Ticket, BarChart3, Users, TrendingUp, Check, Star, Zap } from 'lucide-react';
import { UserRole } from './types';

interface RoleSelectScreenProps {
  onSelect: (role: UserRole) => void;
  onBack: () => void;
}

export function RoleSelectScreen({ onSelect, onBack }: RoleSelectScreenProps) {
  return (
    <div
      style={{
        background: '#060A12',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
        overscrollBehavior: 'none',
      }}
    >
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch' as any,
        scrollbarWidth: 'none' as const,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: 'calc(20px + env(safe-area-inset-top)) 20px 0' }}>
        <button
          onClick={onBack}
          style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
      </div>

      <div style={{ flex: 1, padding: '24px 24px 48px' }}>
        {/* Title */}
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '28px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
            lineHeight: 1.2,
            marginBottom: '8px',
          }}
        >
          How will you
          <br />
          <span style={{ color: '#A855F7' }}>use VENTS?</span>
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, marginBottom: '32px' }}>
          Choose your role so we can personalise your experience.
        </p>

        {/* Attendee card */}
        <div
          onClick={() => onSelect('attendee')}
          style={{
            background: 'linear-gradient(135deg, rgba(79,70,229,0.12) 0%, rgba(123,47,190,0.08) 100%)',
            border: '1.5px solid rgba(79,70,229,0.35)',
            borderRadius: '24px',
            padding: '24px',
            marginBottom: '16px',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* BG decoration */}
          <div
            style={{
              position: 'absolute',
              right: '-20px',
              top: '-20px',
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(79,70,229,0.15) 0%, transparent 70%)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, #4F46E5, #7B2FBE)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
              boxShadow: '0 8px 24px rgba(79,70,229,0.4)',
            }}
          >
            <Ticket size={26} color="#fff" />
          </div>
          <h2
            style={{
              color: '#F0F0FF',
              fontSize: '22px',
              fontWeight: 800,
              fontFamily: 'Space Grotesk, sans-serif',
              marginBottom: '6px',
            }}
          >
            I'm an Attendee
          </h2>
          <p style={{ color: '#C4C9E0', fontSize: '14px', lineHeight: 1.55, marginBottom: '18px' }}>
            Discover, book, and attend the best events across Nigeria.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { icon: Star, text: 'Personalised event recommendations' },
              { icon: Ticket, text: 'Book & manage tickets easily' },
              { icon: Users, text: 'See what friends are attending' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '6px',
                    background: 'rgba(79,70,229,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Check size={12} color="#818CF8" strokeWidth={3} />
                </div>
                <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{text}</span>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: '20px',
              background: 'linear-gradient(135deg, #4F46E5, #7B2FBE)',
              border: 'none',
              borderRadius: '14px',
              padding: '14px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 700,
              fontFamily: 'Space Grotesk, sans-serif',
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            Join as Attendee →
          </div>
        </div>

        {/* Organizer card */}
        <div
          onClick={() => onSelect('organizer')}
          style={{
            background: 'linear-gradient(135deg, rgba(168,85,247,0.12) 0%, rgba(245,158,11,0.06) 100%)',
            border: '1.5px solid rgba(168,85,247,0.35)',
            borderRadius: '24px',
            padding: '24px',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              right: '-20px',
              top: '-20px',
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(168,85,247,0.15) 0%, transparent 70%)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, #A855F7, #7B2FBE)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
              boxShadow: '0 8px 24px rgba(168,85,247,0.4)',
            }}
          >
            <BarChart3 size={26} color="#fff" />
          </div>
          <h2
            style={{
              color: '#F0F0FF',
              fontSize: '22px',
              fontWeight: 800,
              fontFamily: 'Space Grotesk, sans-serif',
              marginBottom: '6px',
            }}
          >
            I'm an Organizer
          </h2>
          <p style={{ color: '#C4C9E0', fontSize: '14px', lineHeight: 1.55, marginBottom: '18px' }}>
            Create events, sell tickets, and grow your audience on VENTS.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[
              { icon: Zap, text: 'Powerful event creation tools' },
              { icon: TrendingUp, text: 'Real-time sales analytics' },
              { icon: Users, text: 'Manage attendees & promotions' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '6px',
                    background: 'rgba(168,85,247,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Check size={12} color="#C084FC" strokeWidth={3} />
                </div>
                <span style={{ color: '#C4C9E0', fontSize: '13px' }}>{text}</span>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: '20px',
              background: 'linear-gradient(135deg, #A855F7, #7B2FBE)',
              border: 'none',
              borderRadius: '14px',
              padding: '14px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 700,
              fontFamily: 'Space Grotesk, sans-serif',
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            Join as Organizer →
          </div>
        </div>
      </div>
    </div>{/* end inner scroll */}
    </div>
  );
}
