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
        background: 'rgba(8,10,20,0.97)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '10px 8px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        zIndex: 50,
      }}
    >
      {TABS.map(({ id, Icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px 0',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '44px',
                height: '36px',
                borderRadius: '18px',
                background: isActive ? 'rgba(123,47,247,0.15)' : 'transparent',
                transition: 'background 0.2s',
              }}
            >
              <Icon
                size={22}
                strokeWidth={isActive ? 2.5 : 1.8}
                color={isActive ? '#7B2FF7' : '#666666'}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
