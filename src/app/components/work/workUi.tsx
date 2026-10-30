import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { ventsColors, ventsTypography } from '../../../lib/ventsDesignTokens';
import type { PillTone } from '../../../lib/workRoles';

// Building blocks for the VENTS Work screens, transcribed one-for-one from
// the approved mockups (VENTS Work Plan, Version 1: .bar, .mlabel, .mcard,
// .row, .ico, .pill, .tiles/.tile, .btn, .hero-work, .chips, .tabs,
// .note-band). Sizes, colors and radii are the mockup's own values; every
// color is the ventsColors token the mockup itself names.

const LINE = ventsColors.border; // rgba(255,255,255,0.09)

export const workPage: CSSProperties = {
  height: '100%',
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  background: ventsColors.bg,
  color: ventsColors.ink1,
  fontFamily: ventsTypography.fontBody,
  overflowX: 'hidden',
};

export const workScroll: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
  padding: '0 12px calc(110px + env(safe-area-inset-bottom))',
  display: 'grid',
  gap: 10,
  alignContent: 'start',
};

export function WorkBar({ title, sub, onBack, right }: { title: string; sub?: string; onBack: () => void; right?: ReactNode }) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'calc(14px + env(safe-area-inset-top)) 16px 4px', flexShrink: 0 }}>
      {/* 44px hit area around the mockup's 28px circle. */}
      <button
        onClick={onBack}
        aria-label="Back"
        style={{ width: 44, height: 44, margin: -8, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 }}
      >
        <span aria-hidden style={{ width: 28, height: 28, borderRadius: '50%', background: ventsColors.elevated, display: 'grid', placeItems: 'center', color: ventsColors.ink2, fontSize: 14 }}>‹</span>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontWeight: 800, fontSize: 15, color: ventsColors.ink1 }}>{title}</h1>
        {sub && <div style={{ fontSize: 11, color: ventsColors.ink3 }}>{sub}</div>}
      </div>
      {right}
    </header>
  );
}

export function MLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: ventsColors.ink3, padding: '4px 4px 0' }}>
      {children}
    </div>
  );
}

export function MCard({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} style={{ background: ventsColors.surface, border: `1px solid ${LINE}`, borderRadius: 14, padding: 12, display: 'grid', gap: 8 }}>
      {children}
    </div>
  );
}

const ICO_TONES = {
  p: { background: 'rgba(142,92,247,0.16)', color: ventsColors.accentSoft },
  c: { background: 'rgba(8,145,178,0.18)', color: '#67E8F9' },
  y: { background: 'rgba(251,191,36,0.15)', color: '#FCD34D' },
  g: { background: 'rgba(52,211,153,0.15)', color: '#6EE7B7' },
} as const;

export function Ico({ tone, children, round }: { tone: keyof typeof ICO_TONES; children: ReactNode; round?: boolean }) {
  return (
    <div aria-hidden style={{ width: 32, height: 32, borderRadius: round ? '50%' : 10, display: 'grid', placeItems: 'center', flexShrink: 0, fontSize: 15, ...ICO_TONES[tone] }}>
      {children}
    </div>
  );
}

const PILL_TONES: Record<PillTone, CSSProperties> = {
  on: { background: 'rgba(52,211,153,0.16)', color: '#6EE7B7' },
  wait: { background: 'rgba(251,191,36,0.16)', color: '#FCD34D' },
  off: { background: 'rgba(255,255,255,0.08)', color: ventsColors.ink2 },
  soon: { background: 'rgba(142,92,247,0.18)', color: ventsColors.accentSoft },
};

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.06em', padding: '3px 7px', borderRadius: 999, whiteSpace: 'nowrap', ...PILL_TONES[tone] }}>
      {children}
    </span>
  );
}

function activate(onClick?: () => void) {
  return onClick
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick,
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } },
      }
    : {};
}

export function Row({ icon, title, sub, right, onClick, testId }: {
  icon?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; testId?: string;
}) {
  return (
    <div data-testid={testId} {...activate(onClick)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, minHeight: 36, cursor: onClick ? 'pointer' : 'default' }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: ventsColors.ink1 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: ventsColors.ink3 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export const Chev = () => <span aria-hidden style={{ color: ventsColors.ink3, fontSize: 13 }}>›</span>;

export function Tiles({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>;
}

export function Tile({ k, v, s, wide, small, onClick, testId }: {
  k: string; v: ReactNode; s?: ReactNode; wide?: boolean; small?: boolean; onClick?: () => void; testId?: string;
}) {
  return (
    <div data-testid={testId} {...activate(onClick)}
      style={{
        background: ventsColors.surface, border: `1px solid ${LINE}`, borderRadius: 12, padding: 10,
        display: 'grid', gap: 2, gridColumn: wide ? '1 / -1' : undefined, cursor: onClick ? 'pointer' : 'default', minWidth: 0,
      }}>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: ventsColors.ink3 }}>{k}</span>
      <span style={small
        ? { fontSize: 13, fontWeight: 800, color: ventsColors.ink2 }
        : { fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: ventsColors.ink1, overflowWrap: 'anywhere' }}>
        {v}
      </span>
      {s && <span style={{ fontSize: 10, color: ventsColors.ink3 }}>{s}</span>}
    </div>
  );
}

export function WorkButton({ children, onClick, ghost, disabled, testId }: {
  children: ReactNode; onClick?: () => void; ghost?: boolean; disabled?: boolean; testId?: string;
}) {
  return (
    <button data-testid={testId} onClick={onClick} disabled={disabled}
      style={{
        width: '100%', minHeight: 44, borderRadius: 12, padding: '9px 12px', textAlign: 'center',
        fontFamily: 'inherit', fontWeight: 700, fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        ...(ghost
          ? { background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', color: ventsColors.ink1 }
          : { background: ventsColors.accentStrong, border: 'none', color: ventsColors.white }),
      }}>
      {children}
    </button>
  );
}

export function NoteBand({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '8px 10px', fontSize: 10.5, color: ventsColors.ink2, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

export function HeroWork({ children, onClick, testId }: { children: ReactNode; onClick?: () => void; testId?: string }) {
  return (
    <div data-testid={testId} {...activate(onClick)}
      style={{ background: ventsColors.elevated, border: '1px solid rgba(142,92,247,0.35)', borderRadius: 16, padding: 14, display: 'grid', gap: 10, cursor: onClick ? 'pointer' : 'default' }}>
      {children}
    </div>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.28)', borderRadius: 10, padding: '8px 10px', fontSize: 11, color: '#FCA5A5' }}>
      {children}
    </div>
  );
}

export function Loading() {
  return <div aria-busy="true" style={{ fontSize: 11, color: ventsColors.ink3, padding: '4px' }}>Loading…</div>;
}
