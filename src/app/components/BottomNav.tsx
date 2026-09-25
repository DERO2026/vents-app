import { TabId } from './types';
import { haptics } from '../../lib/haptics';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  hasUnreadChats?: boolean;
}

// Handoff spec (file 1 §05, B1 HomeScreen footer): four uniform 58x58
// floating circles, active = solid #8E5CF7 fill, inactive = glass
// (rgba(255,255,255,.07) + blur(24px) + rgba(255,255,255,.14) border),
// each labeled with a short JetBrains Mono caps word INSIDE the circle
// (HOME/TIX/CHAT/YOU) rather than an icon + separate label below.
const TABS: { id: TabId; label: string }[] = [
  { id: 'home',       label: 'HOME' },
  { id: 'my-tickets', label: 'TIX'  },
  { id: 'explore',    label: 'CHAT' },
  { id: 'profile',    label: 'YOU'  },
];

export function BottomNav({ activeTab, onTabChange, hasUnreadChats }: BottomNavProps) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: `0 20px calc(20px + env(safe-area-inset-bottom, 6px))`,
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      {TABS.map(({ id, label }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => { if (!isActive) haptics.light(); onTabChange(id); }}
            aria-label={label}
            style={{
              position: 'relative',
              width: '58px',
              height: '58px',
              borderRadius: '9999px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: isActive ? '#8E5CF7' : 'rgba(255,255,255,0.07)',
              backdropFilter: isActive ? 'none' : 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: isActive ? 'none' : 'blur(24px) saturate(160%)',
              border: isActive ? 'none' : '1px solid rgba(255,255,255,0.14)',
              boxShadow: isActive ? '0 12px 34px -10px rgba(142,92,247,1)' : 'none',
              cursor: 'pointer',
              pointerEvents: 'auto',
              flexShrink: 0,
            }}
          >
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '9px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: isActive ? '#fff' : 'rgba(237,234,245,0.8)',
            }}>{label}</span>
            {id === 'explore' && hasUnreadChats && (
              <span style={{
                position: 'absolute', top: '10px', right: '12px',
                width: '9px', height: '9px', borderRadius: '9999px',
                background: '#8E5CF7', border: '2px solid #0B0912', display: 'block',
              }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
