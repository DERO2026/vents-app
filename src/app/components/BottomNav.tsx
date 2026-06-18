import { Home, Compass, Bookmark, User, Ticket } from 'lucide-react';
import { TabId } from './types';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onTicketsPress: () => void;
}

export function BottomNav({ activeTab, onTabChange, onTicketsPress }: BottomNavProps) {
  const tabs: { id: TabId; icon: typeof Home; label: string }[] = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'explore', icon: Compass, label: 'Explore' },
    { id: 'saved', icon: Bookmark, label: 'Saved' },
    { id: 'profile', icon: User, label: 'Profile' },
  ];

  return (
    <div
      style={{
        background: 'rgba(10, 11, 20, 0.95)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
      }}
      className="absolute bottom-0 left-0 right-0 flex items-center justify-around px-2 pt-2 z-50"
    >
      {tabs.map((tab, index) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        if (index === 2) {
          return (
            <div key="tickets-spacer" className="flex flex-col items-center gap-1">
              <button
                onClick={onTicketsPress}
                style={{
                  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                  boxShadow: '0 4px 20px rgba(123, 47, 190, 0.5)',
                }}
                className="w-14 h-14 rounded-2xl flex items-center justify-center -mt-6"
              >
                <Ticket size={24} color="#fff" strokeWidth={2} />
              </button>
              <span style={{ fontSize: '10px', color: '#8B8FA8' }}>Tickets</span>
            </div>
          );
        }

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className="flex flex-col items-center gap-1 min-w-[52px] py-1 transition-all duration-200"
          >
            <div className="relative">
              <Icon
                size={22}
                strokeWidth={isActive ? 2.5 : 1.8}
                color={isActive ? '#A78BFA' : '#8B8FA8'}
              />
              {isActive && (
                <div
                  style={{
                    background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                    width: '4px',
                    height: '4px',
                    borderRadius: '50%',
                  }}
                  className="absolute -bottom-1 left-1/2 -translate-x-1/2"
                />
              )}
            </div>
            <span
              style={{
                fontSize: '10px',
                color: isActive ? '#A78BFA' : '#8B8FA8',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
