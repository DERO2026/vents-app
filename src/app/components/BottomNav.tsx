import { House, Ticket, MessageCircle, Settings } from 'lucide-react';
import { TabId } from './types';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onFabPress: () => void;
  isOrganizer?: boolean;
}

const TABS: { id: TabId; Icon: typeof House; label: string }[] = [
  { id: 'home',       Icon: House,          label: 'Home'     },
  { id: 'my-tickets', Icon: Ticket,         label: 'Tickets'  },
  { id: 'explore',    Icon: MessageCircle,  label: 'Chat'     },
  { id: 'profile',    Icon: Settings,       label: 'Settings' },
];

export function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <div
      style={{
        background: '#0D0D0D',
        borderTop: '1px solid rgba(123,47,247,0.15)',
        boxShadow: '0 -4px 20px rgba(123,47,247,0.08)',
        paddingBottom: 'env(safe-area-inset-bottom, 16px)',
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        height: '64px',
        zIndex: 50,
      }}
    >
      {TABS.map(({ id, Icon, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0',
              position: 'relative',
              gap: '4px',
            }}
          >
            {/* Active indicator line */}
            <div style={{
              position: 'absolute',
              top: 0,
              left: '50%',
              transform: 'translateX(-50%)',
              width: isActive ? '24px' : '0px',
              height: '2px',
              borderRadius: '0 0 2px 2px',
              background: '#7B2FF7',
              transition: 'width 0.25s ease',
            }} />
            {/* Icon pill */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '6px 16px',
              borderRadius: '12px',
              background: isActive ? 'rgba(123,47,247,0.15)' : 'transparent',
              transition: 'background 0.2s',
            }}>
              <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} color={isActive ? '#7B2FF7' : '#555555'} />
            </div>
            {/* Label */}
            <span style={{
              fontSize: '10px',
              fontWeight: isActive ? 700 : 400,
              color: isActive ? '#7B2FF7' : '#555555',
              lineHeight: 1,
            }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
