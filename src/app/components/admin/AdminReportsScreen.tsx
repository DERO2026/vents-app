// Reports queue — ported from the legacy AdminDashboardScreen.tsx 'reports'
// tab as part of its full retirement, with one real fix: Action/Dismiss now
// goes through admin_decide_report() (0122_admin_decide_report.sql) instead
// of a bare client-side UPDATE with zero audit trail, and requires a
// confirmation dialog before either destructive/consequential decision.
import React, { useState, useEffect, useCallback } from 'react';
import { BadgeCheck } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';

interface ReportRow {
  id: string;
  reporter_id: string | null;
  target_type: string;
  target_id: string;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
}

function statusColour(status: string) {
  if (status === 'active') return adminTheme.green;
  if (status === 'suspended') return adminTheme.amber;
  if (status === 'deleted') return adminTheme.red;
  return adminTheme.textMuted;
}

export function AdminReportsScreen() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportedUsers, setReportedUsers] = useState<Record<string, any>>({});
  const [reportedEvents, setReportedEvents] = useState<Record<string, any>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; status: 'actioned' | 'dismissed' } | null>(null);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('reports')
        .select('id, reporter_id, target_type, target_id, reason, details, status, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      const rows = (data as any) || [];
      setReports(rows);

      const userIds = rows.filter((r: any) => r.target_type === 'user').map((r: any) => r.target_id);
      const eventIds = rows.filter((r: any) => r.target_type === 'event').map((r: any) => r.target_id);
      if (userIds.length > 0) {
        const { data: users } = await supabase.from('users').select('id, full_name, username, email, avatar_url, is_verified, status').in('id', userIds);
        const map: Record<string, any> = {};
        (users || []).forEach((u: any) => { map[u.id] = u; });
        setReportedUsers(map);
      }
      if (eventIds.length > 0) {
        const { data: events } = await supabase.from('events').select('id, title, image_url, hidden_by_admin').in('id', eventIds);
        const map: Record<string, any> = {};
        (events || []).forEach((e: any) => { map[e.id] = e; });
        setReportedEvents(map);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (id: string, status: 'actioned' | 'dismissed') => {
    setBusyId(id);
    try {
      const { error } = await supabase.rpc('admin_decide_report' as any, { p_report_id: id, p_status: status });
      if (error) throw error;
      setReports((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
      flash(true, status === 'actioned' ? 'Report actioned.' : 'Report dismissed.');
    } catch (e: any) {
      flash(false, e?.message || 'Failed to update report.');
    } finally { setBusyId(null); }
  };

  return (
    <div data-testid="admin-reports">
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}
      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5, padding: 32 }}>Loading reports…</div>
      ) : reports.length === 0 ? (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No reports yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {reports.map((r) => {
            const statusColor = r.status === 'pending' ? adminTheme.amber : r.status === 'actioned' ? adminTheme.red : r.status === 'dismissed' ? adminTheme.textFaint : adminTheme.green;
            const reportedUser = r.target_type === 'user' ? reportedUsers[r.target_id] : null;
            const reportedEvent = r.target_type === 'event' ? reportedEvents[r.target_id] : null;
            const isBusy = busyId === r.id;
            return (
              <div key={r.id} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: statusColor, background: `${statusColor}20`, padding: '2px 8px', borderRadius: 6 }}>{r.status}</span>
                    <span style={{ fontSize: 11, color: adminTheme.accentText, marginLeft: 8, background: adminTheme.accentSoftBg, padding: '2px 8px', borderRadius: 6 }}>{r.target_type}</span>
                  </div>
                  <span style={{ color: adminTheme.textFainter, fontSize: 10 }}>{new Date(r.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>

                {reportedUser ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: adminTheme.panelAlt, borderRadius: 10, padding: '8px 10px', margin: '0 0 8px' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: adminTheme.accentSoftBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
                      <span style={{ color: adminTheme.accentText, fontSize: 12, fontWeight: 700 }}>{(reportedUser.full_name || reportedUser.username || '?')[0]?.toUpperCase()}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ color: adminTheme.textStrong, fontSize: 12, fontWeight: 600 }}>{reportedUser.full_name || reportedUser.username || 'Unknown'}</span>
                        {reportedUser.is_verified && <BadgeCheck size={12} color={adminTheme.blue} />}
                        <span style={{ fontSize: 9, color: statusColour(reportedUser.status), fontWeight: 600 }}>● {reportedUser.status}</span>
                      </div>
                      <span style={{ color: adminTheme.textMuted, fontSize: 11 }}>@{reportedUser.username} · {reportedUser.email}</span>
                    </div>
                  </div>
                ) : reportedEvent ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: adminTheme.panelAlt, borderRadius: 10, padding: '8px 10px', margin: '0 0 8px' }}>
                    <span style={{ color: adminTheme.textStrong, fontSize: 12, fontWeight: 600 }}>
                      {reportedEvent.title || '(Untitled event)'}{reportedEvent.hidden_by_admin ? ' · Hidden' : ''}
                    </span>
                  </div>
                ) : (
                  <p style={{ color: adminTheme.textFainter, fontSize: 10, margin: '0 0 8px', fontFamily: 'monospace' }}>Target: {r.target_id}</p>
                )}

                <p style={{ color: adminTheme.text, fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>{r.reason}</p>
                {r.details && <p style={{ color: adminTheme.textMuted, fontSize: 12, margin: '0 0 6px' }}>{r.details}</p>}
                <p style={{ color: adminTheme.textFainter, fontSize: 10, margin: '0 0 10px' }}>Reporter: {r.reporter_id?.slice(0, 8)}…</p>

                {r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button disabled={isBusy} onClick={() => setConfirm({ id: r.id, status: 'actioned' })} style={{ flex: 1, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: 8, color: adminTheme.red, fontSize: 12, fontWeight: 600, cursor: isBusy ? 'not-allowed' : 'pointer' }}>Action</button>
                    <button disabled={isBusy} onClick={() => setConfirm({ id: r.id, status: 'dismissed' })} style={{ flex: 1, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: 8, color: adminTheme.textMuted, fontSize: 12, fontWeight: 600, cursor: isBusy ? 'not-allowed' : 'pointer' }}>Dismiss</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.status === 'actioned' ? 'Action this report?' : 'Dismiss this report?'}
          message={confirm.status === 'actioned'
            ? 'This marks the report as actioned. Take any follow-up moderation (suspend/hide) separately from Users/Events.'
            : 'This marks the report as dismissed with no further action taken.'}
          confirmLabel={confirm.status === 'actioned' ? 'Action' : 'Dismiss'}
          danger={confirm.status === 'actioned'}
          onConfirm={() => { const c = confirm; setConfirm(null); if (c) decide(c.id, c.status); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
