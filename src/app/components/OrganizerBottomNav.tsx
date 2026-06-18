import { LayoutDashboard, Calendar, Plus, BarChart3, User } from 'lucide-react';

export type OrgTab = 'org-dashboard' | 'manage-events' | 'sales-analytics' | 'profile';

interface OrganizerBottomNavProps {
  activeTab: OrgTab;
  onTabChange: (tab: OrgTab) => void;
  onCreatePress: () => void;
}

const LEFT_TABS: { id: OrgTab; icon: typeof LayoutDashboard; label: string }[] = [
  { id: 'org-dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { id: 'manage-events', icon: Calendar, label: 'My Events' },
];

const RIGHT_TABS: { id: OrgTab; icon: typeof LayoutDashboard; label: string }[] = [
  { id: 'sales-analytics', icon: BarChart3, label: 'Analytics' },
  { id: 'profile', icon: User, label: 'Profile' },
];

export function OrganizerBottomNav({ activeTab, onTabChange, onCreatePress }: OrganizerBottomNavProps) {
  const renderTab = (tab: { id: OrgTab; icon: typeof LayoutDashboard; label: string }) => {
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
              style={{ background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', width: '4px', height: '4px', borderRadius: '50%' }}
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

  return (
    <div
      style={{
        background: 'rgba(10,11,20,0.97)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(168,85,247,0.2)',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
      }}
      className="absolute bottom-0 left-0 right-0 flex items-center justify-around px-2 pt-2 z-50"
    >
      {LEFT_TABS.map(renderTab)}

      {/* Center spacer + floating create button */}
      <div className="flex flex-col items-center" style={{ gap: '2px', minWidth: '52px' }}>
        <button
          onClick={onCreatePress}
          style={{
            background: 'linear-gradient(135deg, #A855F7 0%, #7B2FBE 100%)',
            boxShadow: '0 4px 20px rgba(168,85,247,0.55)',
            width: '52px',
            height: '52px',
            borderRadius: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
            marginTop: '-22px',
          }}
        >
          <Plus size={22} color="#fff" strokeWidth={2.5} />
        </button>
        <span style={{ fontSize: '10px', color: '#8B8FA8' }}>Create</span>
      </div>

      {RIGHT_TABS.map(renderTab)}
    </div>
  );
}
