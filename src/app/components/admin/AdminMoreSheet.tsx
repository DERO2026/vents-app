import React from 'react';
import { adminTheme, ADMIN_NAV_ITEMS, MOBILE_PRIMARY_KEYS, ROOT_ONLY_KEYS, ADMIN_TIER_ONLY_KEYS, AdminConsoleViewKey } from './adminConsoleTheme';

interface AdminMoreSheetProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: AdminConsoleViewKey) => void;
  activeView: AdminConsoleViewKey;
  isRoot: boolean;
  isSuperAdmin: boolean;
}

// Mobile "More" bottom sheet (export lines ~1001-1016) — every nav area not
// in the 4 primary bottom tabs.
export function AdminMoreSheet({ open, onClose, onNavigate, activeView, isRoot, isSuperAdmin }: AdminMoreSheetProps) {
  if (!open) return null;
  const items = ADMIN_NAV_ITEMS.filter(
    (i) => !MOBILE_PRIMARY_KEYS.includes(i.key) && (!ADMIN_TIER_ONLY_KEYS.includes(i.key) || isSuperAdmin)
  );

  return (
    <div
      data-testid="admin-more-sheet"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 30, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxHeight: '70vh',
          overflowY: 'auto',
          background: adminTheme.panelSidebar,
          borderTop: '1px solid #2c2438',
          borderRadius: '16px 16px 0 0',
          padding: '16px 14px calc(16px + env(safe-area-inset-bottom))',
        }}
      >
        <div style={{ width: 36, height: 4, background: '#2c2438', borderRadius: 2, margin: '0 auto 14px' }} />
        {items.map((item) => {
          const active = activeView === item.key;
          const locked = ROOT_ONLY_KEYS.includes(item.key) && !isRoot;
          return (
            <div
              key={item.key}
              role="button"
              tabIndex={0}
              aria-disabled={locked}
              onClick={() => { if (!locked) { onNavigate(item.key); onClose(); } }}
              style={{
                cursor: locked ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 10px',
                borderRadius: 8,
                marginBottom: 2,
                fontSize: 13.5,
                fontWeight: active ? 700 : 500,
                color: locked ? adminTheme.textFainter : active ? '#f0e8ff' : '#d6cfe0',
                background: active ? adminTheme.accentSoftBg : 'transparent',
                minHeight: 44,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: active ? 'rgba(163,92,255,.25)' : '#181322',
                  color: active ? adminTheme.accentText : adminTheme.textFaint,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {item.mono}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {locked && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    color: '#8a7a9e',
                    background: '#1c1726',
                    border: '1px solid #2c2438',
                    padding: '2px 6px',
                    borderRadius: 5,
                  }}
                >
                  ROOT
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
