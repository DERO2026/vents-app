// Batch 2 — Event Detail. Follows design-export's v_eventDetail block
// (~366-448): header card + tab strip, single-pane on mobile with back nav.
//
// Real data sources:
//  - Event fields + organizer: `events` row joined to `users`.
//  - Overview stats + Check-ins/attendance: get_event_analytics(event_id)
//    RPC (migrations/supabase/migrations/0042_event_analytics.sql), which
//    explicitly allows public.is_admin() for ANY event, not just the
//    caller's own — a real, already-shipped admin-accessible aggregate.
//  - Audit: `admin_logs` filtered on details->>'event_id' (the exact key
//    admin_hide_event/admin_reinstate_event/admin_set_event_featured write).
// Explicit "not available" (no fabrication):
//  - Tickets (per-buyer list) and Refunds: `tickets` RLS only allows the
//    ticket's own owner or the event's organizer to read individual rows;
//    there is no admin bypass and no admin RPC that lists ticket buyers for
//    an arbitrary event.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { isSuperAdmin as permIsSuperAdmin, type PermissionUser } from '../../../lib/permissions';
import { hideEvent, reinstateEvent, toggleEventFeatured } from './adminUserEventActions';

interface FullEventRow {
  id: string; title: string | null; organizer_id: string | null; hidden_by_admin: boolean; hidden_at: string | null;
  created_at: string; event_date: string | null; venue: string | null; deleted_at: string | null;
  is_featured: boolean; featured_until: string | null;
  'users!events_organizer_id_fkey'?: { username: string | null; full_name: string | null; is_verified: boolean } | null;
}

interface Analytics {
  overview: { soldCount: number; soldQuantity: number; grossKobo: number; pendingCount: number; cancelledCount: number; refundedCount: number };
  attendance: { checkedInCount: number; soldQuantity: number; attendancePct: number | null };
}

interface AuditRow { id: string; action: string; details: Record<string, any>; created_at: string; actor_role: string | null; }

type Tab = 'overview' | 'tickets' | 'checkins' | 'refunds' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'checkins', label: 'Check-ins' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'audit', label: 'Audit' },
];

const NGN = (kobo: number) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');

function NotAvailable({ reason }: { reason: string }) {
  return (
    <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
      Not available — {reason}
    </div>
  );
}

export function AdminEventDetail({ eventId, currentUser, isMobile, onBack }: {
  eventId: string; currentUser: PermissionUser | null | undefined; isMobile: boolean; onBack: () => void;
}) {
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const [event, setEvent] = useState<FullEventRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadEvent = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: err } = await supabase
        .from('events')
        .select('id, title, organizer_id, hidden_by_admin, hidden_at, created_at, event_date, venue, deleted_at, is_featured, featured_until, users!events_organizer_id_fkey(username, full_name, is_verified)')
        .eq('id', eventId)
        .maybeSingle();
      if (err) throw err;
      if (!data) throw new Error('Event not found.');
      setEvent(data as any);
    } catch (e: any) {
      setError(e?.message || 'Failed to load event.');
    } finally { setLoading(false); }
  }, [eventId]);

  useEffect(() => { loadEvent(); }, [loadEvent]);

  useEffect(() => {
    if (tab !== 'overview' && tab !== 'checkins') return;
    if (analytics || analyticsLoading) return;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    Promise.resolve(supabase.rpc('get_event_analytics' as any, { p_event_id: eventId }))
      .then(({ data, error: err }: any) => {
        if (err) throw err;
        setAnalytics(data as any);
      })
      .catch((e: any) => setAnalyticsError(e?.message || 'Failed to load ticket stats.'))
      .finally(() => setAnalyticsLoading(false));
  }, [tab, eventId, analytics, analyticsLoading]);

  useEffect(() => {
    if (tab !== 'audit') return;
    setAuditLoading(true);
    Promise.resolve(
      (supabase.from('admin_logs').select('id, action, details, created_at, actor_role') as any)
        .eq('details->>event_id', eventId).order('created_at', { ascending: false }).limit(50),
    )
      .then(({ data }: any) => setAudit(data || []))
      .catch(() => setAudit([]))
      .finally(() => setAuditLoading(false));
  }, [tab, eventId]);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };
  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    const res = await fn();
    flash(res.ok, res.message);
    if (res.ok) await loadEvent();
    setBusy(false);
  };

  if (loading) return <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 32, textAlign: 'center' }}>Loading event…</div>;
  if (error || !event) return (
    <div>
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Events</div>
      <div style={{ color: adminTheme.red, fontSize: 12.5 }}>{error || 'Event not found.'}</div>
    </div>
  );

  const organizer = event['users!events_organizer_id_fkey'];
  const label = event.title || event.id;
  const status = event.deleted_at ? { bg: 'rgba(248,113,113,.12)', fg: adminTheme.red, label: 'Deleted' }
    : event.hidden_by_admin ? { bg: 'rgba(251,191,36,.12)', fg: adminTheme.amber, label: 'Hidden' }
    : { bg: 'rgba(52,211,153,.12)', fg: adminTheme.green, label: 'Visible' };

  return (
    <div data-testid="admin-event-detail">
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Events</div>
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}

      <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: isMobile ? 16 : '20px 22px', marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: adminTheme.textStrong }}>{label}</div>
            <div style={{ fontSize: 12.5, color: adminTheme.textMuted, marginTop: 4 }}>
              by {organizer?.username ? `@${organizer.username}` : organizer?.full_name || 'Unknown organizer'}
              {event.event_date && ` · ${new Date(event.event_date).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`}
              {event.venue && ` · ${event.venue}`}
            </div>
            <span style={{ display: 'inline-block', marginTop: 8, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: status.bg, color: status.fg }}>{status.label}</span>
          </div>
          {!event.deleted_at && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button disabled={busy} onClick={() => run(() => toggleEventFeatured(isSuperAdmin, event.id, label, !!event.is_featured))}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: event.is_featured ? 'rgba(251,191,36,.12)' : adminTheme.borderChip, border: `1px solid ${event.is_featured ? 'rgba(251,191,36,.35)' : adminTheme.border}`, color: event.is_featured ? adminTheme.amber : adminTheme.text, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {event.is_featured ? '★ Featured' : '☆ Feature'}
              </button>
              <button disabled={busy} onClick={() => run(() => event.hidden_by_admin ? reinstateEvent(isSuperAdmin, event.id, label) : hideEvent(isSuperAdmin, event.id, label))}
                style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: event.hidden_by_admin ? 'rgba(52,211,153,.1)' : 'rgba(248,113,113,.1)', border: `1px solid ${event.hidden_by_admin ? 'rgba(52,211,153,.3)' : 'rgba(248,113,113,.3)'}`, color: event.hidden_by_admin ? adminTheme.green : adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {event.hidden_by_admin ? 'Reinstate' : 'Unpublish'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${adminTheme.borderSoft}`, marginBottom: 18, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {TABS.map((t) => (
          <div key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
            color: tab === t.key ? adminTheme.text : adminTheme.textFaint,
            borderBottom: tab === t.key ? `2px solid ${adminTheme.accentFrom}` : '2px solid transparent',
          }}>{t.label}</div>
        ))}
      </div>

      {tab === 'overview' && (
        analyticsLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading ticket stats…</div>
        : analyticsError ? <NotAvailable reason={analyticsError} />
        : analytics ? (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 14 }}>
            {[
              { label: 'TICKETS SOLD', value: String(analytics.overview.soldQuantity) },
              { label: 'GROSS REVENUE', value: NGN(analytics.overview.grossKobo) },
              { label: 'PENDING PAYMENT', value: String(analytics.overview.pendingCount) },
              { label: 'REFUNDED', value: String(analytics.overview.refundedCount) },
            ].map((s) => (
              <div key={s.label} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>{s.label}</div>
                <div style={{ fontSize: 19, fontWeight: 800, color: adminTheme.textStrong }}>{s.value}</div>
              </div>
            ))}
          </div>
        ) : null
      )}

      {tab === 'tickets' && <NotAvailable reason="tickets RLS only allows the ticket owner or the event's organizer to read individual rows — no admin bypass or RPC lists a specific event's buyers today." />}

      {tab === 'checkins' && (
        analyticsLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading check-in data…</div>
        : analyticsError ? <NotAvailable reason={analyticsError} />
        : analytics ? (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 150, background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 18, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: adminTheme.green }}>{analytics.attendance.checkedInCount}</div>
              <div style={{ fontSize: 12, color: adminTheme.textMuted, marginTop: 4 }}>Checked in via Door Manager</div>
            </div>
            <div style={{ flex: 1, minWidth: 150, background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 18, textAlign: 'center' }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: adminTheme.textStrong }}>{analytics.attendance.soldQuantity}</div>
              <div style={{ fontSize: 12, color: adminTheme.textMuted, marginTop: 4 }}>Total tickets sold</div>
            </div>
          </div>
        ) : null
      )}

      {tab === 'refunds' && <NotAvailable reason="same tickets RLS limitation as the Tickets tab — no admin-accessible listing of refunds for an arbitrary event exists yet." />}

      {tab === 'audit' && (
        auditLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading audit trail…</div>
        : audit.length === 0 ? <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No admin actions recorded for this event.</div>
        : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {audit.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 12, padding: '13px 16px', borderBottom: `1px solid ${adminTheme.borderSoft}`, fontSize: 12.5, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <div style={{ color: adminTheme.textFaint, width: isMobile ? '100%' : 130, flexShrink: 0 }}>{new Date(a.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                <div style={{ color: adminTheme.text, flex: 1 }}>{a.action.replace(/_/g, ' ')}</div>
                <div style={{ color: adminTheme.textMuted }}>{a.actor_role || '—'}</div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
