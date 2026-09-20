import React, { useEffect, useState, useCallback } from 'react';
import { adminTheme, ADMIN_NAV_ITEMS, AdminConsoleViewKey } from './adminConsoleTheme';
import { AdminSidebar } from './AdminSidebar';
import { AdminTopbar } from './AdminTopbar';
import { AdminMobileNav } from './AdminMobileNav';
import { AdminMoreSheet } from './AdminMoreSheet';
import { AdminDashboard } from './AdminDashboard';
import { isRoot as permIsRoot, isSuperAdmin as permIsSuperAdmin, isAdminTier as permIsAdminTier, type PermissionUser } from '../../../lib/permissions';

export interface AdminConsoleShellProps {
  currentUser: PermissionUser | null | undefined;
  onBack: () => void;
  // Optional hook to jump into the legacy AdminDashboardScreen's matching
  // tab for a nav area this Batch 1 build doesn't have its own screen for
  // yet — per scope, Batch 1 only wires LINKS to those 21 other areas, it
  // does not build new screens for them.
  onOpenLegacyTab?: (tab: string) => void;
}

const TABLET_BREAKPOINT = 768;
const DESKTOP_BREAKPOINT = 1200;

// Maps a console nav key to the equivalent tab in the existing
// AdminDashboardScreen, where one already exists.
const LEGACY_TAB_FOR_VIEW: Partial<Record<AdminConsoleViewKey, string>> = {
  users: 'users',
  events: 'events',
  organizers: 'org-requests',
  providers: 'services-admin',
  vcents: 'vc',
  reports: 'reports',
  adminActions: 'admin-actions',
  verification: 'verify',
  system: 'system',
  auditLogs: 'logs',
  finance: 'payouts',
  payments: 'payouts',
  refunds: 'payouts',
};

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

// New, separate admin console screen (Batch 1: shell + responsive nav +
// dashboard only). Does not replace AdminDashboardScreen — both coexist.
export function AdminConsoleShell({ currentUser, onBack, onOpenLegacyTab }: AdminConsoleShellProps) {
  const width = useViewportWidth();
  const isMobile = width < TABLET_BREAKPOINT;
  const isTablet = width >= TABLET_BREAKPOINT && width < DESKTOP_BREAKPOINT;
  const isDesktop = width >= DESKTOP_BREAKPOINT;

  const isRoot = permIsRoot(currentUser);
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const isAdminTier = permIsAdminTier(currentUser);

  const [view, setView] = useState<AdminConsoleViewKey>('overview');
  const [moreOpen, setMoreOpen] = useState(false);

  const navigate = useCallback((key: AdminConsoleViewKey) => {
    setView(key);
    setMoreOpen(false);
  }, []);

  const roleLabel = isRoot ? 'ROOT · FULL ACCESS' : isSuperAdmin ? 'ADMIN · OPERATIONS' : 'SUB-ADMIN · OPERATIONS';
  const roleName = (currentUser as any)?.full_name || (currentUser as any)?.username || 'Admin';

  const pageTitle = ADMIN_NAV_ITEMS.find((i) => i.key === view)?.label || 'Dashboard';
  const showBack = view !== 'overview';

  if (!isAdminTier) {
    return (
      <div style={{ padding: 40, color: adminTheme.text, background: adminTheme.bg, minHeight: '100%' }}>
        You do not have access to the admin console.
      </div>
    );
  }

  const content =
    view === 'overview' ? (
      <AdminDashboard
        currentUser={currentUser}
        isRoot={isRoot}
        isSuperAdmin={isSuperAdmin}
        isMobile={isMobile}
        isTablet={isTablet}
        onNavigate={(key) => navigate(key)}
      />
    ) : (
      <LegacyLinkPanel viewKey={view} onOpenLegacyTab={onOpenLegacyTab} />
    );

  return (
    <div style={{ display: 'flex', height: '100%', background: adminTheme.bg, color: adminTheme.text, fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden' }}>
      {!isMobile && (
        <AdminSidebar
          activeView={view}
          onNavigate={navigate}
          isTablet={isTablet}
          isRoot={isRoot}
          isSuperAdmin={isSuperAdmin}
          roleLabel={roleLabel}
          roleName={roleName}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', position: 'relative' }}>
        <AdminTopbar pageTitle={pageTitle} isMobile={isMobile} showBack={showBack} onBack={() => navigate('overview')} />

        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px 76px' : '26px 30px 60px' }}>
          {content}
        </div>

        {isMobile && (
          <AdminMobileNav activeView={view} onNavigate={navigate} onMore={() => setMoreOpen((v) => !v)} moreOpen={moreOpen} />
        )}
      </div>

      {isMobile && (
        <AdminMoreSheet
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          onNavigate={navigate}
          activeView={view}
          isRoot={isRoot}
          isSuperAdmin={isSuperAdmin}
        />
      )}
    </div>
  );
}

// Honest placeholder for the 21 admin areas out of scope for Batch 1 — links
// out to the existing tab in AdminDashboardScreen when one exists, otherwise
// says so plainly. Never fabricates a screen for these.
function LegacyLinkPanel({ viewKey, onOpenLegacyTab }: { viewKey: AdminConsoleViewKey; onOpenLegacyTab?: (tab: string) => void }) {
  const legacyTab = LEGACY_TAB_FOR_VIEW[viewKey];
  const label = ADMIN_NAV_ITEMS.find((i) => i.key === viewKey)?.label || viewKey;
  return (
    <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: adminTheme.textMuted, marginBottom: 16 }}>
        This area is not part of Batch 1 of the Admin Console rebuild yet.
        {legacyTab ? ' It is available today in the existing admin dashboard.' : ' No screen exists for it yet.'}
      </div>
      {legacyTab && onOpenLegacyTab && (
        <button
          type="button"
          onClick={() => onOpenLegacyTab(legacyTab)}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '9px 14px',
            borderRadius: 8,
            background: adminTheme.accentSoftBg,
            border: `1px solid ${adminTheme.accentSoftBorder}`,
            color: adminTheme.accentText,
            cursor: 'pointer',
            minHeight: 44,
          }}
        >
          Open in Admin Dashboard →
        </button>
      )}
    </div>
  );
}
