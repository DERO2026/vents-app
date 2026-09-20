import React from 'react';
import { adminTheme, ADMIN_NAV_ITEMS, MOBILE_PRIMARY_KEYS, AdminConsoleViewKey } from './adminConsoleTheme';

interface AdminMobileNavProps {
  activeView: AdminConsoleViewKey;
  onNavigate: (view: AdminConsoleViewKey) => void;
  onMore: () => void;
  moreOpen: boolean;
}

// Mobile bottom tab bar (<768px) — export lines ~984-996. Fixed 4 primary
// items + a "More" tab. Touch targets are >=44px tall.
export function AdminMobileNav({ activeView, onNavigate, onMore, moreOpen }: AdminMobileNavProps) {
  const primary = ADMIN_NAV_ITEMS.filter((i) => MOBILE_PRIMARY_KEYS.includes(i.key));
  const moreActive = moreOpen || !MOBILE_PRIMARY_KEYS.includes(activeView);

  return (
    <div
      data-testid="admin-mobile-nav"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 60,
        background: adminTheme.panelSidebar,
        borderTop: `1px solid ${adminTheme.borderSoft}`,
        display: 'flex',
        padding: '4px 4px calc(4px + env(safe-area-inset-bottom))',
        zIndex: 20,
      }}
    >
      {primary.map((item) => {
        const active = activeView === item.key && !moreOpen;
        return (
          <div
            key={item.key}
            role="button"
            tabIndex={0}
            onClick={() => onNavigate(item.key)}
            style={{
              flex: 1,
              minHeight: 44,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              padding: '6px 0',
              cursor: 'pointer',
              color: active ? adminTheme.accentText : adminTheme.textFaint,
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 20,
                height: 20,
                borderRadius: 6,
                background: active ? 'rgba(163,92,255,.25)' : '#181322',
                color: active ? adminTheme.accentText : adminTheme.textFaint,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 9,
                fontWeight: 700,
              }}
            >
              {item.mono}
            </span>
            {item.label}
          </div>
        );
      })}
      <div
        role="button"
        tabIndex={0}
        onClick={onMore}
        style={{
          flex: 1,
          minHeight: 44,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          padding: '6px 0',
          cursor: 'pointer',
          color: moreActive ? adminTheme.accentText : adminTheme.textFaint,
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: moreActive ? 'rgba(163,92,255,.25)' : '#181322',
            color: moreActive ? adminTheme.accentText : adminTheme.textFaint,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          ••
        </span>
        More
      </div>
    </div>
  );
}
