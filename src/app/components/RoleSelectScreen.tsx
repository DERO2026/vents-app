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
        background: '#020005',
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
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.07)',
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
        <p style={{ color: '#94A3B8', fontSize: '13px', lineHeight: 1.5 }}>
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
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '24px',
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
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'rgba(123,47,190,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Ticket size={20} color="#7B2FBE" />
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
          <div style={{ marginTop: '12px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', borderRadius: '100px', padding: '11px', color: '#fff', fontSize: '14px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', textAlign: 'center', boxShadow: '0 8px 24px rgba(123,47,190,0.35)' }}>
            Join as Attendee →
          </div>
        </div>

        {/* Organizer card */}
        <div
          onClick={() => onSelect('organizer')}
          style={{
            flex: 1,
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '24px',
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
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'rgba(123,47,190,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <BarChart3 size={20} color="#7B2FBE" />
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
          <div style={{ marginTop: '12px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', borderRadius: '100px', padding: '11px', color: '#fff', fontSize: '14px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', textAlign: 'center', boxShadow: '0 8px 24px rgba(123,47,190,0.35)' }}>
            Join as Organizer →
          </div>
        </div>

      </div>
    </div>
  );
}
