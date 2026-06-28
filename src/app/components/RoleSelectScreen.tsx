import { ArrowLeft, Ticket, BarChart3, Users, TrendingUp, Check, Star, Zap, DollarSign } from 'lucide-react';
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
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: 'calc(14px + env(safe-area-inset-top)) 20px 0', flexShrink: 0 }}>
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

      {/* Title */}
      <div style={{ padding: '12px 24px 8px', flexShrink: 0 }}>
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '24px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
            lineHeight: 1.2,
            marginBottom: '4px',
          }}
        >
          How will you{' '}
          <span style={{ color: '#A855F7' }}>use VENTS?</span>
        </h1>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5 }}>
          Choose your role to personalise your experience.
        </p>
      </div>

      {/* Cards — no scroll, both always visible */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '8px 20px calc(16px + env(safe-area-inset-bottom))', gap: '12px', overflow: 'hidden' }}>

        {/* Attendee card */}
        <div
          onClick={() => onSelect('attendee')}
          style={{
            flex: 1,
            background: 'linear-gradient(135deg, rgba(79,70,229,0.12) 0%, rgba(123,47,190,0.08) 100%)',
            border: '1.5px solid rgba(79,70,229,0.35)',
            borderRadius: '20px',
            padding: '16px 18px',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ position: 'absolute', right: '-16px', top: '-16px', width: '90px', height: '90px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(79,70,229,0.15) 0%, transparent 70%)', pointerEvents: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #4F46E5, #7B2FBE)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 12px rgba(79,70,229,0.4)' }}>
              <Ticket size={20} color="#fff" />
            </div>
            <div>
              <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>I'm an Attendee</h2>
              <p style={{ color: '#C4C9E0', fontSize: '12px', margin: '2px 0 0' }}>Discover, book, and attend the best events across Nigeria</p>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
            {[
              { icon: Star, text: 'Personalised event recommendations' },
              { icon: Ticket, text: 'Book and manage tickets easily' },
              { icon: Users, text: 'See what friends are attending' },
              { icon: DollarSign, text: 'Earn Vents Cents on every booking' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '18px', height: '18px', borderRadius: '5px', background: 'rgba(79,70,229,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Check size={10} color="#818CF8" strokeWidth={3} />
                </div>
                <span style={{ color: '#C4C9E0', fontSize: '12px' }}>{text}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '12px', background: 'linear-gradient(135deg, #4F46E5, #7B2FBE)', borderRadius: '12px', padding: '11px', color: '#fff', fontSize: '14px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', textAlign: 'center' }}>
            Join as Attendee →
          </div>
        </div>

        {/* Organizer card */}
        <div
          onClick={() => onSelect('organizer')}
          style={{
            flex: 1,
            background: 'linear-gradient(135deg, rgba(168,85,247,0.12) 0%, rgba(245,158,11,0.06) 100%)',
            border: '1.5px solid rgba(168,85,247,0.35)',
            borderRadius: '20px',
            padding: '16px 18px',
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ position: 'absolute', right: '-16px', top: '-16px', width: '90px', height: '90px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,85,247,0.15) 0%, transparent 70%)', pointerEvents: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #A855F7, #7B2FBE)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 12px rgba(168,85,247,0.4)' }}>
              <BarChart3 size={20} color="#fff" />
            </div>
            <div>
              <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>I'm an Organizer</h2>
              <p style={{ color: '#C4C9E0', fontSize: '12px', margin: '2px 0 0' }}>Create events, sell tickets, and grow your audience on VENTS</p>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
            {[
              { icon: Zap, text: 'Powerful event creation tools' },
              { icon: TrendingUp, text: 'Real-time sales analytics' },
              { icon: Users, text: 'Manage attendees and promotions' },
              { icon: DollarSign, text: 'Get paid directly to your wallet' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '18px', height: '18px', borderRadius: '5px', background: 'rgba(168,85,247,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Check size={10} color="#C084FC" strokeWidth={3} />
                </div>
                <span style={{ color: '#C4C9E0', fontSize: '12px' }}>{text}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '12px', background: 'linear-gradient(135deg, #A855F7, #7B2FBE)', borderRadius: '12px', padding: '11px', color: '#fff', fontSize: '14px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', textAlign: 'center' }}>
            Join as Organizer →
          </div>
        </div>

      </div>
    </div>
  );
}
