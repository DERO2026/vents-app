import React, { useEffect, useState, useCallback } from 'react';
import { adminTheme, ADMIN_NAV_ITEMS, AdminConsoleViewKey } from './adminConsoleTheme';
import { AdminSidebar } from './AdminSidebar';
import { AdminTopbar } from './AdminTopbar';
import { AdminMobileNav } from './AdminMobileNav';
import { AdminMoreSheet } from './AdminMoreSheet';
import { AdminDashboard } from './AdminDashboard';
import { AdminUsersList } from './AdminUsersList';
import { AdminUserDetail } from './AdminUserDetail';
import { AdminEventsList } from './AdminEventsList';
import { AdminEventDetail } from './AdminEventDetail';
import { AdminProvidersList } from './AdminProvidersList';
import { AdminProviderDetail } from './AdminProviderDetail';
import { AdminOrganizersList } from './AdminOrganizersList';
import { AdminOrganizerDetail } from './AdminOrganizerDetail';
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
  // Batch 2: Users/Events list-to-detail drill-in state, local to this shell
  // (mirrors the export's own back-to-list navigation for these two areas).
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Batch 3: Service Providers/Organizers list-to-detail drill-in state,
  // same convention as Batch 2's selectedUserId/selectedEventId above.
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedOrganizerId, setSelectedOrganizerId] = useState<string | null>(null);

  const navigate = useCallback((key: AdminConsoleViewKey) => {
    setView(key);
    setMoreOpen(false);
    setSelectedUserId(null);
    setSelectedEventId(null);
    setSelectedProviderId(null);
    setSelectedOrganizerId(null);
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
    ) : view === 'users' ? (
      selectedUserId ? (
        <AdminUserDetail userId={selectedUserId} currentUser={currentUser} isMobile={isMobile} onBack={() => setSelectedUserId(null)} />
      ) : (
        <AdminUsersList isMobile={isMobile} onSelectUser={setSelectedUserId} />
      )
    ) : view === 'events' ? (
      selectedEventId ? (
        <AdminEventDetail eventId={selectedEventId} currentUser={currentUser} isMobile={isMobile} onBack={() => setSelectedEventId(null)} />
      ) : (
        <AdminEventsList isMobile={isMobile} currentUser={currentUser} onSelectEvent={setSelectedEventId} />
      )
    ) : view === 'providers' ? (
      selectedProviderId ? (
        <AdminProviderDetail providerId={selectedProviderId} isSuperAdmin={isSuperAdmin} isMobile={isMobile} onBack={() => setSelectedProviderId(null)} />
      ) : (
        <AdminProvidersList isMobile={isMobile} onSelectProvider={setSelectedProviderId} />
      )
    ) : view === 'organizers' ? (
      selectedOrganizerId ? (
        <AdminOrganizerDetail organizerId={selectedOrganizerId} isSuperAdmin={isSuperAdmin} isMobile={isMobile} onBack={() => setSelectedOrganizerId(null)} />
      ) : (
        <AdminOrganizersList isMobile={isMobile} onSelectOrganizer={setSelectedOrganizerId} />
      )
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
