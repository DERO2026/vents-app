import { Home, Ticket, MessageCircle, User, Sparkles } from 'lucide-react';
import { TabId } from './types';
import { haptics } from '../../lib/haptics';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  hasUnreadChats?: boolean;
  // SI (VENTS SI) is its own first-class fifth destination, but it isn't a
  // TabId/Screen the rest of the tab-root plumbing (TAB_SCREENS,
  // handleTabChange) understands -- it's opened as a full-screen overlay
  // (see App.tsx's `screen === 'vents-ai'`), same as before this redesign,
  // just reached from here instead of a separate floating orb. Kept as its
  // own trio of props rather than folded into TabId, to avoid widening that
  // type (and everywhere it's switched on) for a destination that isn't a
  // tab-content screen the same way Home/Passes/Chats/Profile are.
  siActive?: boolean;
  // Settings > SI toggle (ventsAiEnabled in App.tsx) -- when off, SI must
  // not become a broken destination: the tab renders visibly dimmed and
  // disabled instead of silently doing nothing or opening a dead screen.
  siEnabled?: boolean;
  onOpenSi?: () => void;
}

const TABS: { id: TabId; label: string; Icon: typeof Home }[] = [
  { id: 'home',       label: 'Home',    Icon: Home },
  { id: 'my-tickets', label: 'Passes',  Icon: Ticket },
  { id: 'explore',    label: 'Chats',   Icon: MessageCircle },
  { id: 'profile',    label: 'Profile', Icon: User },
];

// A frosted-glass single bar holding all five destinations (Home / Passes /
// Chats / Profile / SI), replacing the earlier four separate floating
// circles -- a deliberate, restrained VENTS surface rather than a generic
// icon-row tab bar. SI sits last and gets a distinct purple-gradient glyph
// so it reads as a first-class destination, not a sixth identical icon.
export function BottomNav({ activeTab, onTabChange, hasUnreadChats, siActive, siEnabled = true, onOpenSi }: BottomNavProps) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: `0 12px calc(10px + env(safe-area-inset-bottom, 6px))`,
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          maxWidth: '390px',
          background: 'rgba(14,11,22,0.72)',
          backdropFilter: 'blur(28px) saturate(170%)',
          WebkitBackdropFilter: 'blur(28px) saturate(170%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '22px',
          padding: '6px 4px',
          boxShadow: '0 14px 40px -14px rgba(0,0,0,0.6)',
          pointerEvents: 'auto',
        }}
      >
        {TABS.map(({ id, label, Icon }) => {
          const isActive = activeTab === id && !siActive;
          return (
            <button
              key={id}
              onClick={() => { if (!isActive) haptics.light(); onTabChange(id); }}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '3px',
                padding: '8px 2px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <div
                style={{
                  position: 'relative',
                  width: '34px',
                  height: '26px',
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: isActive ? 'rgba(142,92,247,0.18)' : 'transparent',
                  transition: 'background 0.15s ease',
                }}
              >
                <Icon size={19} strokeWidth={isActive ? 2.3 : 2} color={isActive ? '#B98CFF' : 'rgba(237,234,245,0.55)'} />
                {id === 'explore' && hasUnreadChats && (
                  <span style={{
                    position: 'absolute', top: '1px', right: '3px',
                    width: '7px', height: '7px', borderRadius: '9999px',
                    background: '#8E5CF7', border: '1.5px solid #0B0912', display: 'block',
                  }} />
                )}
              </div>
              <span style={{
                fontSize: '10px',
                fontWeight: isActive ? 700 : 600,
                letterSpacing: '0.01em',
                color: isActive ? '#F3EEFF' : 'rgba(237,234,245,0.5)',
                fontFamily: "'Inter', system-ui, sans-serif",
              }}>{label}</span>
            </button>
          );
        })}

        <button
          onClick={() => {
            if (!siEnabled) return;
            if (!siActive) haptics.light();
            onOpenSi?.();
          }}
          aria-label="SI"
          aria-current={siActive ? 'page' : undefined}
          aria-disabled={!siEnabled || undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '3px',
            padding: '8px 2px',
            border: 'none',
            background: 'transparent',
            cursor: siEnabled ? 'pointer' : 'default',
            opacity: siEnabled ? 1 : 0.35,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <div
            style={{
              width: '34px',
              height: '26px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: siActive
                ? 'linear-gradient(135deg,#c084fc,#7c3aed)'
                : 'rgba(255,255,255,0.06)',
              transition: 'background 0.15s ease',
            }}
          >
            <Sparkles size={17} strokeWidth={siActive ? 2.3 : 2} color={siActive ? '#fff' : 'rgba(237,234,245,0.55)'} />
          </div>
          <span style={{
            fontSize: '10px',
            fontWeight: siActive ? 700 : 600,
            letterSpacing: '0.01em',
            color: siActive ? '#F3EEFF' : 'rgba(237,234,245,0.5)',
            fontFamily: "'Inter', system-ui, sans-serif",
          }}>SI</span>
        </button>
      </div>
    </div>
  );
}
