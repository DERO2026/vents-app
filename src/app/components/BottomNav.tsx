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
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-around',
        padding: `0 20px calc(20px + env(safe-area-inset-bottom, 6px))`,
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      {TABS.map(({ id, Icon, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => { if (!isActive) haptics.light(); onTabChange(id); }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              pointerEvents: 'auto',
            }}
          >
            <div style={{
              width: isActive ? '52px' : '48px',
              height: isActive ? '52px' : '48px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: isActive
                ? 'linear-gradient(160deg, rgba(168,85,247,0.3), rgba(79,70,229,0.3))'
                : 'rgba(255,255,255,0.07)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              border: isActive ? '1px solid rgba(196,181,253,0.32)' : '1px solid rgba(255,255,255,0.12)',
              boxShadow: isActive
                ? '0 4px 12px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.12)'
                : '0 6px 18px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.08)',
              transition: 'all 0.2s ease',
            }}>
              <Icon
                size={isActive ? 20 : 19}
                strokeWidth={isActive ? 2.2 : 2}
                color={isActive ? '#FFFFFF' : '#9CA0BC'}
              />
            </div>

            <span style={{
              fontSize: '10px',
              fontWeight: isActive ? 700 : 600,
              color: isActive ? '#F0F0FF' : '#9CA0BC',
              lineHeight: 1,
            }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
