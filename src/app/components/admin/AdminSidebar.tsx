import React from 'react';
import { adminTheme, accentGradient, visibleNavItems, ROOT_ONLY_KEYS, AdminConsoleViewKey } from './adminConsoleTheme';

interface AdminSidebarProps {
  activeView: AdminConsoleViewKey;
  onNavigate: (view: AdminConsoleViewKey) => void;
  isTablet: boolean; // icon-only collapsed sidebar
  isRoot: boolean;
  isSuperAdmin: boolean;
  roleLabel: string;
  roleName: string;
}

// Desktop (full, labeled) / tablet (icon-only, collapsed) persistent sidebar.
// Structure mirrors design-export/"VENTS Admin Console.dc.html" lines ~24-71:
// logo row -> role card (desktop only) -> nav list -> footer (desktop only).
export function AdminSidebar({ activeView, onNavigate, isTablet, isRoot, isSuperAdmin, roleLabel, roleName }: AdminSidebarProps) {
  const items = visibleNavItems(isRoot, isSuperAdmin);
  const width = isTablet ? 76 : 252;

  return (
    <div
      data-testid="admin-sidebar"
      style={{
        width,
        flexShrink: 0,
        background: adminTheme.panelSidebar,
        borderRight: `1px solid ${adminTheme.borderSoft}`,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width .15s',
      }}
    >
      <div style={{ padding: '18px 16px 14px', display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
        <div
          aria-hidden
          style={{ height: 22, width: 22, borderRadius: 6, background: accentGradient, flexShrink: 0 }}
        />
        {!isTablet && (
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 1.5, color: adminTheme.textFaint }}>
            ADMIN
          </span>
        )}
      </div>

      {!isTablet && (
        <div
          style={{
            margin: '2px 16px 14px',
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(163,92,255,.10)',
            border: '1px solid rgba(163,92,255,.28)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e4d4ff' }}>{roleName}</div>
              <div style={{ fontSize: 10.5, color: '#a891d4', fontWeight: 600, letterSpacing: 0.3, marginTop: 1 }}>
                {roleLabel}
              </div>
            </div>
            <div
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: '50%', background: adminTheme.green, boxShadow: `0 0 6px ${adminTheme.green}`, flexShrink: 0 }}
            />
          </div>
        </div>
      )}

      <nav style={{ flex: 1, overflowY: 'auto', padding: '2px 12px 12px' }} aria-label="Admin console navigation">
        {items.map((item) => {
          const active = activeView === item.key;
          const locked = ROOT_ONLY_KEYS.includes(item.key) && !isRoot;
          return (
            <div
              key={item.key}
              role="button"
              tabIndex={0}
              aria-disabled={locked}
              title={item.label}
              onClick={() => !locked && onNavigate(item.key)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !locked) onNavigate(item.key); }}
              style={{
                cursor: locked ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 10px',
                borderRadius: 8,
                marginBottom: 2,
                fontSize: 12.5,
                fontWeight: active ? 700 : 500,
                color: locked ? adminTheme.textFainter : active ? '#f0e8ff' : adminTheme.textMuted,
                background: active ? adminTheme.accentSoftBg : 'transparent',
                minHeight: 44,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: active ? 'rgba(163,92,255,.25)' : '#181322',
                  color: active ? adminTheme.accentText : adminTheme.textFaint,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 9.5,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {item.mono}
              </span>
              {!isTablet && (
                <>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {locked && (
                    <span
                      style={{
                        fontSize: 8.5,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        color: '#8a7a9e',
                        background: '#1c1726',
                        border: '1px solid #2c2438',
                        padding: '2px 5px',
                        borderRadius: 5,
                      }}
                    >
                      ROOT
                    </span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </nav>

      {!isTablet && (
        <div style={{ padding: '14px 20px', borderTop: `1px solid ${adminTheme.borderSoft}`, fontSize: 10.5, color: adminTheme.textFainter, lineHeight: 1.5 }}>
          VENTS Internal Ops
          <br />
          Admin Console
        </div>
      )}
    </div>
  );
}
