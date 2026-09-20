import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme, accentGradient } from './adminConsoleTheme';
import type { PermissionUser } from '../../../lib/permissions';

const NGN = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');

interface MetricTile {
  label: string;
  value: string;
  trend: string;
  trendColor: string;
  available: boolean;
  source: string; // name of the RPC/table backing this metric, or the reason it's unavailable
  onClick?: () => void;
}

interface DashboardData {
  totalUsers: number | null;
  totalEvents: number | null;
  ticketRevenue: number | null;
  vcCirculation: number | null;
  pendingAdminActions: number | null;
  pendingVerifications: number | null;
  openReports: number | null;
}

interface AdminDashboardProps {
  currentUser: PermissionUser | null | undefined;
  isRoot: boolean;
  isSuperAdmin: boolean;
  isMobile: boolean;
  isTablet: boolean;
  onNavigate: (key: 'adminActions' | 'verification' | 'reports') => void;
}

// Batch 1 dashboard — every tile traces to a real query/RPC, or is shown as
// an explicit "Not yet available" state (never a fabricated number). See
// AGENTS.md scope boundary + STEP 2.B of the task brief for the audit this
// follows. Layout mirrors design-export's `v_overview` block (stat grid +
// alerts/GMV row + pending-queue tiles), reflowed per the export's own
// `statGrid` / `overviewChartsGrid` responsive rules.
export function AdminDashboard({ currentUser, isRoot, isSuperAdmin, isMobile, isTablet, onNavigate }: AdminDashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [usersRes, eventsRes, ticketsRes, vcRes, pendingActionsRes, verifStatsRes, reportsRes] = await Promise.all([
        supabase.from('users').select('id', { count: 'exact', head: true }),
        supabase.from('events').select('id', { count: 'exact', head: true }).is('deleted_at', null),
        supabase.from('tickets').select('amount').eq('payment_status', 'paid'),
        supabase.rpc('admin_get_vc_aggregates' as any),
        supabase.rpc('admin_pending_request_count' as any, {}),
        supabase.rpc('admin_get_verification_stats' as any),
        supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      ]);

      const ticketRevenue = (ticketsRes.data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const vcRow = (vcRes.data || [])[0] || {};
      const verifRow = (verifStatsRes.data || [])[0] || {};

      setData({
        totalUsers: usersRes.count ?? null,
        totalEvents: eventsRes.count ?? null,
        ticketRevenue,
        vcCirculation: vcRow.circulation != null ? Number(vcRow.circulation) : null,
        pendingAdminActions: pendingActionsRes.data != null ? Number(pendingActionsRes.data) : null,
        pendingVerifications: verifRow.pending_count != null ? Number(verifRow.pending_count) : null,
        openReports: reportsRes.count ?? null,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const statGrid = isMobile ? 'repeat(2, minmax(0, 1fr))' : isTablet ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))';

  const metrics: MetricTile[] = data
    ? [
        {
          label: 'Total users',
          value: data.totalUsers != null ? data.totalUsers.toLocaleString('en-NG') : '—',
          trend: 'Live count',
          trendColor: adminTheme.green,
          available: data.totalUsers != null,
          source: "users table row count",
        },
        {
          label: 'Total events',
          value: data.totalEvents != null ? data.totalEvents.toLocaleString('en-NG') : '—',
          trend: 'Excludes deleted',
          trendColor: adminTheme.green,
          available: data.totalEvents != null,
          source: 'events table row count (deleted_at is null)',
        },
        {
          label: 'Ticket revenue (paid)',
          value: data.ticketRevenue != null ? NGN(data.ticketRevenue) : '—',
          trend: 'All-time, paid tickets',
          trendColor: adminTheme.green,
          available: data.ticketRevenue != null,
          source: "tickets.amount sum where payment_status='paid'",
        },
        {
          label: 'VC in circulation',
          value: data.vcCirculation != null ? `${data.vcCirculation.toLocaleString('en-NG')} VC` : '—',
          trend: 'Platform-wide balance',
          trendColor: adminTheme.amber,
          available: data.vcCirculation != null,
          source: 'admin_get_vc_aggregates() RPC',
        },
        {
          label: 'Wallet liability',
          value: 'Not yet available',
          trend: 'No platform-wide aggregate RPC exists yet',
          trendColor: adminTheme.textFaint,
          available: false,
          source: 'missing: no admin-gated sum over user_wallets / organizer_wallets',
        },
        {
          label: 'Referral activity',
          value: 'Not yet available',
          trend: 'No aggregate RPC exists yet',
          trendColor: adminTheme.textFaint,
          available: false,
          source: 'missing: no admin referrals aggregate',
        },
        {
          label: 'Pending admin actions',
          value: data.pendingAdminActions != null ? data.pendingAdminActions.toLocaleString('en-NG') : '—',
          trend: 'Maker-checker queue',
          trendColor: data.pendingAdminActions ? adminTheme.amber : adminTheme.green,
          available: data.pendingAdminActions != null,
          source: 'admin_pending_request_count() RPC',
          onClick: () => onNavigate('adminActions'),
        },
        {
          label: 'Open reports',
          value: data.openReports != null ? data.openReports.toLocaleString('en-NG') : '—',
          trend: 'Status = pending',
          trendColor: data.openReports ? adminTheme.red : adminTheme.green,
          available: data.openReports != null,
          source: "reports table row count where status='pending'",
          onClick: () => onNavigate('reports'),
        },
      ]
    : [];

  const pendingQueues = data
    ? [
        {
          label: 'Pending organizer/provider verification',
          count: data.pendingVerifications,
          onClick: () => onNavigate('verification'),
        },
        {
          label: 'Admin Actions awaiting approval',
          count: data.pendingAdminActions,
          onClick: () => onNavigate('adminActions'),
          rootOnlyActionable: false,
        },
        {
          label: 'Open safety reports',
          count: data.openReports,
          onClick: () => onNavigate('reports'),
        },
      ]
    : [];

  return (
    <div data-testid="admin-dashboard">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 13, color: adminTheme.textMuted }}>Platform pulse across events, services and finance</div>
        {isSuperAdmin ? (
          <div style={{ fontSize: 11, color: adminTheme.textFaint }}>Full admin view</div>
        ) : (
          <div style={{ fontSize: 11, color: adminTheme.textFaint }}>Sub-admin view — informational only</div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          style={{
            background: 'rgba(248,113,113,.1)',
            border: '1px solid rgba(248,113,113,.3)',
            color: adminTheme.red,
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12.5,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: statGrid, gap: 14, marginBottom: 16 }}>
        {loading && !data
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16, minHeight: 84 }} />
            ))
          : metrics.map((m) => (
              <div
                key={m.label}
                role={m.onClick ? 'button' : undefined}
                tabIndex={m.onClick ? 0 : undefined}
                onClick={m.onClick}
                style={{
                  background: adminTheme.panel,
                  border: `1px solid ${adminTheme.border}`,
                  borderRadius: 12,
                  padding: 16,
                  cursor: m.onClick ? 'pointer' : 'default',
                  opacity: m.available ? 1 : 0.75,
                  minHeight: 44,
                }}
              >
                <div style={{ fontSize: 11, color: '#8a7f97', fontWeight: 600, marginBottom: 8 }}>{m.label}</div>
                <div style={{ fontSize: m.available ? 22 : 14, fontWeight: 800, color: m.available ? adminTheme.textStrong : adminTheme.textFaint, letterSpacing: -0.5 }}>
                  {m.value}
                </div>
                <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 6, color: m.trendColor }}>{m.trend}</div>
              </div>
            ))}
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: adminTheme.text, marginBottom: 10, marginTop: 8 }}>Pending action queues</div>
      <div style={{ display: 'grid', gridTemplateColumns: statGrid, gap: 14 }}>
        {pendingQueues.map((q) => {
          // Root-only enforcement is at the RPC layer already (is_admin()/
          // is_root() gates the underlying actions); the tile just reflects
          // that true state instead of hiding itself.
          const disabled = false; // every queue here is informational + admin/sub-admin readable
          return (
            <div
              key={q.label}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              onClick={disabled ? undefined : q.onClick}
              style={{
                cursor: disabled ? 'not-allowed' : 'pointer',
                background: adminTheme.panel,
                border: `1px solid ${adminTheme.border}`,
                borderRadius: 12,
                padding: 16,
                opacity: disabled ? 0.5 : 1,
                minHeight: 44,
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 800, color: '#e4d4ff' }}>{q.count != null ? q.count : '—'}</div>
              <div style={{ fontSize: 12, color: adminTheme.textMuted, marginTop: 4 }}>{q.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function accentSwatch() {
  return accentGradient;
}
