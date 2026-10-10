import { Home, Ticket, LayoutGrid, MessageSquare, User, Sparkle } from 'lucide-react';
import { TabId } from './types';
import { haptics } from '../../lib/haptics';

interface BottomNavProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  hasUnreadChats?: boolean;
  // VENTS AI is its own first-class sixth destination, but it isn't a
  // TabId/Screen the rest of the tab-root plumbing (TAB_SCREENS,
  // handleTabChange) understands -- it's opened as a full-screen overlay
  // (see App.tsx's `screen === 'vents-ai'`), same as before this redesign,
  // just reached from here instead of a separate floating orb. Kept as its
  // own trio of props (still named si*/Si for continuity with the existing
  // vents-ai screen plumbing and tests) rather than folded into TabId, to
  // avoid widening that type (and everywhere it's switched on) for a
  // destination that isn't a tab-content screen the same way
  // Home/Tix/Services/Chat/You are.
  siActive?: boolean;
  // Settings > VENTS AI toggle (ventsAiEnabled in App.tsx) -- when off,
  // VENTS AI must not become a broken destination: the tab renders
  // visibly dimmed and disabled instead of silently doing nothing or
  // opening a dead screen.
  siEnabled?: boolean;
  onOpenSi?: () => void;
}

// Icon choices and exact colors/dimensions below are reverse-engineered
// line-for-line from VentsPrototype.dc.html's own `dock` row (the
// const P = {...} icon paths and the dock button's inline style string) --
// not invented here. Services uses a 2x2 grid glyph (the prototype's own
// `svc` path is four rounded squares, i.e. lucide's LayoutGrid, not a
// storefront icon); Chat uses a square speech bubble (the prototype's
// `chat` path matches lucide's MessageSquare, not the rounder
// MessageCircle); VENTS AI uses a single four-point sparkle (the
// prototype's `ai` path is one diamond-ish star, matching lucide's
// Sparkle, not the three-dot Sparkles).
const TABS: { id: TabId; label: string; Icon: typeof Home }[] = [
  { id: 'home',       label: 'Home',     Icon: Home },
  { id: 'my-tickets', label: 'Tix',      Icon: Ticket },
  { id: 'services',   label: 'Services', Icon: LayoutGrid },
  { id: 'explore',    label: 'Chat',     Icon: MessageSquare },
  { id: 'profile',    label: 'You',      Icon: User },
];

// Dock colors/dimensions below are the prototype's exact values (its own
// `showDock` block's inline style and the `dock` array's per-item
// bg/color), not a reinterpretation:
//   container: left/right 10px, bottom 14px, height 68px, radius 34px,
//     background rgba(28,22,56,.62), backdrop-filter blur(26px) saturate(1.5),
//     border 1px solid rgba(255,255,255,.16),
//     box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 14px 34px rgba(0,0,0,.55)
//   each button: flex:1, radius 28px, label font 600 9.5px Manrope
//   inactive (non-AI): transparent bg, color #b4aecb
//   active (non-AI): bg rgba(139,92,246,.55), color #fff
//   inactive AI: transparent bg, color #c4b5fd (already purple-tinted,
//     unlike the other four tabs' neutral inactive gray)
//   active AI: bg linear-gradient(135deg,#8b5cf6,#6d28d9), color #fff
// The one addition beyond the prototype's static markup is a restrained
// pulsing glow on the active AI tab, which the Design Foundation's own
// component spec calls for explicitly ("purple glow is reserved for one
// thing per screen: the primary action or the AI entry") -- not a new
// visual invented here, just the one glow the design docs already ask for.
export function BottomNav({ activeTab, onTabChange, hasUnreadChats, siActive, siEnabled = true, onOpenSi }: BottomNavProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: '10px',
        right: '10px',
        bottom: `calc(14px + env(safe-area-inset-bottom, 0px))`,
        height: '68px',
        borderRadius: '34px',
        background: 'rgba(28,22,56,0.62)',
        backdropFilter: 'blur(26px) saturate(150%)',
        WebkitBackdropFilter: 'blur(26px) saturate(150%)',
        border: '1px solid rgba(255,255,255,0.16)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14), 0 14px 34px rgba(0,0,0,0.55)',
        display: 'flex',
        padding: '5px',
        gap: '2px',
        zIndex: 50,
        maxWidth: '480px',
        margin: '0 auto',
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
              position: 'relative',
              border: 'none',
              borderRadius: '28px',
              background: isActive ? 'rgba(139,92,246,0.55)' : 'transparent',
              color: isActive ? '#fff' : '#b4aecb',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              padding: 0,
              cursor: 'pointer',
              transition: 'background 0.15s ease',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <Icon size={22} strokeWidth={1.8} color="currentColor" />
            {id === 'explore' && hasUnreadChats && (
              <span style={{
                position: 'absolute', top: '6px', right: 'calc(50% - 15px)',
                width: '7px', height: '7px', borderRadius: '9999px',
                background: '#8E5CF7', border: '1.5px solid #1c1638', display: 'block',
              }} />
            )}
            <span style={{ font: "600 9.5px 'Manrope', sans-serif", whiteSpace: 'nowrap' }}>{label}</span>
          </button>
        );
      })}

      <button
        onClick={() => {
          if (!siEnabled) return;
          if (!siActive) haptics.light();
          onOpenSi?.();
        }}
        aria-label="VENTS AI"
        aria-current={siActive ? 'page' : undefined}
        aria-disabled={!siEnabled || undefined}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          borderRadius: '28px',
          background: siActive ? 'linear-gradient(135deg,#8b5cf6,#6d28d9)' : 'transparent',
          color: siActive ? '#fff' : '#c4b5fd',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          padding: 0,
          cursor: siEnabled ? 'pointer' : 'default',
          opacity: siEnabled ? 1 : 0.35,
          boxShadow: siActive ? '0 0 14px 2px rgba(139,92,246,0.55)' : 'none',
          animation: siActive ? 'ventsAiTabGlow 2.4s ease-in-out infinite' : 'none',
          transition: 'background 0.15s ease',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <Sparkle size={22} strokeWidth={1.8} color="currentColor" fill={siActive ? 'currentColor' : 'none'} />
        <span style={{ font: "600 9.5px 'Manrope', sans-serif", whiteSpace: 'nowrap' }}>VENTS AI</span>
      </button>
      <style>{`
        @keyframes ventsAiTabGlow {
          0%, 100% { box-shadow: 0 0 10px 1px rgba(139,92,246,0.45); }
          50% { box-shadow: 0 0 18px 4px rgba(139,92,246,0.75); }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes ventsAiTabGlow { 0%, 100% { box-shadow: 0 0 14px 2px rgba(139,92,246,0.55); } }
        }
      `}</style>
    </div>
  );
}
