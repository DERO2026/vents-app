import { Home, Ticket, MessageCircle, User } from 'lucide-react';
import { TabId } from './types';
import { haptics } from '../../lib/haptics';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TABS: { id: TabId; Icon: typeof Home; label: string }[] = [
  { id: 'home',       Icon: Home,          label: 'Home'      },
  { id: 'my-tickets', Icon: Ticket,        label: 'My Tickets' },
  { id: 'explore',    Icon: MessageCircle, label: 'Chats'      },
  { id: 'profile',    Icon: User,          label: 'Profile'    },
];

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <div
      style={{
        background: 'rgba(13,13,13,0.95)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(123,47,247,0.2)',
        boxShadow: '0 -8px 32px rgba(123,47,247,0.12)',
        borderRadius: '24px 24px 0 0',
        paddingBottom: 'env(safe-area-inset-bottom, 8px)',
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'stretch',
        height: '70px',
        zIndex: 50,
      }}
    >
      {TABS.map(({ id, Icon, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => { if (!isActive) haptics.light(); onTabChange(id); }}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              paddingTop: '8px',
              paddingBottom: '0',
              position: 'relative',
              gap: '4px',
              transition: 'all 0.2s ease',
            }}
          >
            {/* Active indicator pill at top */}
            <div style={{
              position: 'absolute',
              top: 0,
              left: '50%',
              transform: `translateX(-50%)`,
              width: isActive ? '20px' : '0px',
              height: '3px',
              borderRadius: '0 0 4px 4px',
              background: 'linear-gradient(90deg, #7B2FF7, #F107A3)',
              transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            }} />

            {/* Icon with pill background when active */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 20px',
              borderRadius: '14px',
              background: isActive
                ? 'linear-gradient(135deg, rgba(123,47,247,0.3), rgba(241,7,163,0.2))'
                : 'transparent',
              transition: 'all 0.2s ease',
            }}>
              <Icon
                size={isActive ? 22 : 20}
                strokeWidth={isActive ? 2.2 : 1.8}
                color={isActive ? '#FFFFFF' : '#444444'}
              />
            </div>

            {/* Label */}
            <span style={{
              fontSize: '9px',
              fontWeight: isActive ? 800 : 500,
              color: isActive ? '#FFFFFF' : '#444444',
              letterSpacing: isActive ? '0.8px' : '0.5px',
              textTransform: 'uppercase',
              lineHeight: 1,
            }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
