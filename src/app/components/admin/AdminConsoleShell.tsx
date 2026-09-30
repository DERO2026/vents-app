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
import { AdminPayoutsScreen } from './AdminPayoutsScreen';
import { AdminVCScreen } from './AdminVCScreen';
import { AdminReportsScreen } from './AdminReportsScreen';
import { AdminAuditLogScreen } from './AdminAuditLogScreen';
import { AdminAnalyticsScreen } from './AdminAnalyticsScreen';
import { AdminVerificationScreen } from './AdminVerificationScreen';
import { AdminSystemScreen } from './AdminSystemScreen';
import { AdminServiceBookingsScreen } from './AdminServiceBookingsScreen';
import { AdminActionsTab } from '../AdminActionsTab';
import { isRoot as permIsRoot, isSuperAdmin as permIsSuperAdmin, isAdminTier as permIsAdminTier, type PermissionUser } from '../../../lib/permissions';
import { supabase } from '../../../lib/supabase';

export interface AdminConsoleShellProps {
  currentUser: PermissionUser | null | undefined;
  onBack: () => void;
}

const TABLET_BREAKPOINT = 768;
const DESKTOP_BREAKPOINT = 1200;

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

// The sole Admin Console. AdminDashboardScreen (the legacy console) has been
// fully retired — every function it exposed now lives here (see the
// migration's reconciliation report for the full feature-by-feature map).
export function AdminConsoleShell({ currentUser, onBack }: AdminConsoleShellProps) {
  const width = useViewportWidth();
  const isMobile = width < TABLET_BREAKPOINT;
  const isTablet = width >= TABLET_BREAKPOINT && width < DESKTOP_BREAKPOINT;

  const isRoot = permIsRoot(currentUser);
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const isAdminTier = permIsAdminTier(currentUser);

  const [view, setView] = useState<AdminConsoleViewKey>('overview');
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedOrganizerId, setSelectedOrganizerId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pendingActionCount, setPendingActionCount] = useState(0);

  // Stable identity (empty deps): AdminActionsTab's own load() depends on
  // `flash` in its useCallback dependency array, so a new identity here on
  // every AdminConsoleShell render would re-trigger its fetch on every
  // unrelated re-render -- the exact render-cascade bug already fixed once
  // in the legacy AdminDashboardScreen and carried forward here.
  const flash = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshPendingCount = useCallback(async () => {
    try {
      const { data } = await supabase.rpc('admin_pending_request_count' as any, {});
      setPendingActionCount(Number(data) || 0);
    } catch { /* ignore — sidebar badge is a convenience, not a source of truth */ }
  }, []);

  useEffect(() => {
    refreshPendingCount();
    const interval = setInterval(refreshPendingCount, 20000);
    return () => clearInterval(interval);
  }, [refreshPendingCount]);

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
  // Always show a back control: on Overview it exits the console back to the
  // app (there is no other console to fall back to any more); on any other
  // view it returns to Overview first, matching the export's own nav model.
  const showBack = true;
  const handleBack = view === 'overview' ? onBack : () => navigate('overview');

  if (!isAdminTier) {
    return (
      <div style={{ padding: 40, color: adminTheme.text, background: adminTheme.bg, minHeight: '100%' }}>
        You do not have access to the admin console.
      </div>
    );
  }

  const content =
    view === 'overview' ? (
      <AdminDashboard currentUser={currentUser} isRoot={isRoot} isSuperAdmin={isSuperAdmin} isMobile={isMobile} isTablet={isTablet} onNavigate={(key) => navigate(key)} />
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
        <AdminProvidersList isMobile={isMobile} isSuperAdmin={isSuperAdmin} onSelectProvider={setSelectedProviderId} />
      )
    ) : view === 'organizers' ? (
      selectedOrganizerId ? (
        <AdminOrganizerDetail organizerId={selectedOrganizerId} isSuperAdmin={isSuperAdmin} isMobile={isMobile} onBack={() => setSelectedOrganizerId(null)} />
      ) : (
        <AdminOrganizersList isMobile={isMobile} isSuperAdmin={isSuperAdmin} onSelectOrganizer={setSelectedOrganizerId} />
      )
    ) : view === 'finance' ? (
      <AdminPayoutsScreen />
    ) : view === 'vcents' ? (
      <AdminVCScreen />
    ) : view === 'reports' ? (
      <AdminReportsScreen />
    ) : view === 'auditLogs' ? (
      <AdminAuditLogScreen />
    ) : view === 'analytics' ? (
      <AdminAnalyticsScreen />
    ) : view === 'verification' ? (
      <AdminVerificationScreen />
    ) : view === 'adminActions' ? (
      <AdminActionsTab isSuperAdmin={isSuperAdmin} flash={flash} onCountChange={refreshPendingCount} />
    ) : view === 'serviceBookings' ? (
      <AdminServiceBookingsScreen />
    ) : view === 'system' && isRoot ? (
      <AdminSystemScreen currentUser={currentUser as { id: string; role?: string }} />
    ) : (
      <div style={{ padding: 24, color: adminTheme.textFaint, fontSize: 13 }}>Root access required.</div>
    );

  return (
    <div style={{ display: 'flex', height: '100%', background: adminTheme.bg, color: adminTheme.text, fontFamily: "'Inter', system-ui, sans-serif", overflow: 'hidden' }}>
      {!isMobile && (
        <AdminSidebar activeView={view} onNavigate={navigate} isTablet={isTablet} isRoot={isRoot} isSuperAdmin={isSuperAdmin} roleLabel={roleLabel} roleName={roleName} pendingActionCount={pendingActionCount} />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', position: 'relative' }}>
        <AdminTopbar pageTitle={pageTitle} isMobile={isMobile} showBack={showBack} onBack={handleBack} />

        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px 14px 76px' : '26px 30px 60px' }}>
          {toast && (
            <div style={{ marginBottom: 14, fontSize: 12.5, padding: '8px 12px', borderRadius: 8, background: toast.ok ? 'rgba(52,211,153,.1)' : 'rgba(248,113,113,.1)', border: `1px solid ${toast.ok ? 'rgba(52,211,153,.3)' : 'rgba(248,113,113,.3)'}`, color: toast.ok ? adminTheme.green : adminTheme.red }}>
              {toast.msg}
            </div>
          )}
          {content}
        </div>

        {isMobile && (
          <AdminMobileNav activeView={view} onNavigate={navigate} onMore={() => setMoreOpen((v) => !v)} moreOpen={moreOpen} />
        )}
      </div>

      {isMobile && (
        <AdminMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} onNavigate={navigate} activeView={view} isRoot={isRoot} isSuperAdmin={isSuperAdmin} />
      )}
    </div>
  );
}
