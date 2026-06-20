import { Home, Compass, Ticket, User, Plus } from 'lucide-react';
import { TabId } from './types';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  onFabPress: () => void;
  isOrganizer?: boolean;
}

export function BottomNav({ activeTab, onTabChange, onFabPress, isOrganizer = false }: BottomNavProps) {
  const attendeeTabs: { id: TabId; icon: typeof Home; label: string }[] = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'explore', icon: Compass, label: 'Explore' },
    // index 2 is replaced by FAB
    { id: 'profile', icon: User, label: 'Profile' },
  ];

  const orgTabs: { id: TabId; icon: typeof Home; label: string }[] = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'explore', icon: Compass, label: 'Explore' },
    // index 2 is replaced by FAB
    { id: 'my-tickets', icon: Ticket, label: 'Tickets' },
    { id: 'profile', icon: User, label: 'Profile' },
  ];

  const tabs = isOrganizer ? orgTabs : attendeeTabs;

  const renderTab = (tab: { id: TabId; icon: typeof Home; label: string }) => {
    const Icon = tab.icon;
    const isActive = activeTab === tab.id;
    return (
      <button
        key={tab.id}
        onClick={() => onTabChange(tab.id)}
        className="flex flex-col items-center gap-1 min-w-[52px] py-1 transition-all duration-200"
      >
        <div className="relative">
          <Icon size={22} strokeWidth={isActive ? 2.5 : 1.8} color={isActive ? '#A78BFA' : '#8B8FA8'} />
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
        <span style={{ fontSize: '10px', color: isActive ? '#A78BFA' : '#8B8FA8', fontWeight: isActive ? 600 : 400 }}>
          {tab.label}
        </span>
      </button>
    );
  };

  const fabStyle: React.CSSProperties = {
    background: isOrganizer
      ? 'linear-gradient(135deg, #A855F7 0%, #7B2FBE 100%)'
      : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
    boxShadow: isOrganizer
      ? '0 4px 20px rgba(168,85,247,0.5)'
      : '0 4px 20px rgba(123,47,190,0.5)',
    width: '56px',
    height: '56px',
    borderRadius: '18px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    marginTop: '-24px',
  };

  return (
    <div
      style={{
        background: isOrganizer ? 'rgba(10,11,20,0.97)' : 'rgba(10,11,20,0.95)',
        backdropFilter: 'blur(20px)',
        borderTop: isOrganizer ? '1px solid rgba(168,85,247,0.2)' : '1px solid rgba(255,255,255,0.08)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      className="absolute bottom-0 left-0 right-0 flex items-center justify-around px-2 pt-2 pb-3 z-50"
    >
      {/* Render first 2 tabs */}
      {tabs.slice(0, 2).map(renderTab)}

      {/* Center FAB */}
      <div className="flex flex-col items-center" style={{ gap: '2px', minWidth: '52px' }}>
        <button onClick={onFabPress} style={fabStyle}>
          {isOrganizer ? (
            <Plus size={24} color="#fff" strokeWidth={2.5} />
          ) : (
            <Ticket size={24} color="#fff" strokeWidth={2} />
          )}
        </button>
        <span style={{ fontSize: '10px', color: '#8B8FA8' }}>
          {isOrganizer ? 'Create' : 'Tickets'}
        </span>
      </div>

      {/* Render remaining tabs */}
      {tabs.slice(2).map(renderTab)}
    </div>
  );
}
