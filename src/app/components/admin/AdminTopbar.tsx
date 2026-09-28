import React from 'react';
import { adminTheme, accentGradient } from './adminConsoleTheme';

interface AdminTopbarProps {
  pageTitle: string;
  isMobile: boolean;
  showBack: boolean;
  onBack: () => void;
}

// Desktop/tablet topbar (export ~75-92) and compact mobile topbar (~94-105).
// These are two visually distinct chrome pieces, not one shrunk down.
export function AdminTopbar({ pageTitle, isMobile, showBack, onBack }: AdminTopbarProps) {
  if (isMobile) {
    return (
      <div
        data-testid="admin-topbar-mobile"
        style={{
          height: 52,
          flexShrink: 0,
          borderBottom: `1px solid ${adminTheme.borderSoft}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          background: adminTheme.panelTopbar,
        }}
      >
        {showBack ? (
          <div role="button" tabIndex={0} onClick={onBack} style={{ fontSize: 20, color: '#e4d4ff', cursor: 'pointer', width: 28, minHeight: 44, display: 'flex', alignItems: 'center' }}>
            ←
          </div>
        ) : (
          <div aria-hidden style={{ height: 18, width: 18, borderRadius: 5, background: accentGradient }} />
        )}
        <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: adminTheme.text, textAlign: 'center' }}>{pageTitle}</div>
        <div
          aria-hidden
          style={{ width: 26, height: 26, borderRadius: 8, background: accentGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 800, color: '#fff' }}
        >
          7
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="admin-topbar-desktop"
      style={{
        height: 64,
        flexShrink: 0,
        borderBottom: `1px solid ${adminTheme.borderSoft}`,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 28px',
        background: adminTheme.panelTopbar,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: adminTheme.text }}>{pageTitle}</div>
      <div style={{ flex: 1, maxWidth: 420, marginLeft: 8 }}>
        <input
          placeholder="Search users, events, organizers, providers…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: adminTheme.panelAlt,
            border: `1px solid ${adminTheme.borderChip}`,
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12.5,
            color: '#e8e3ee',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      </div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: adminTheme.red,
          background: 'rgba(248,113,113,.12)',
          border: '1px solid rgba(248,113,113,.3)',
          padding: '5px 9px',
          borderRadius: 6,
        }}
      >
        LIVE ENVIRONMENT
      </div>
      <div
        aria-hidden
        style={{ width: 34, height: 34, borderRadius: 10, background: accentGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: '#fff' }}
      >
        7
      </div>
      <div
        aria-hidden
        style={{ width: 34, height: 34, borderRadius: '50%', background: accentGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#fff' }}
      >
        AC
      </div>
    </div>
  );
}
