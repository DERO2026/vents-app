// Organizer Upgrade Requests — ported from the legacy
// AdminDashboardScreen.tsx 'org-requests' tab as part of its full
// retirement. This is the queue for users applying to BECOME an organizer
// (organizer_requests table) -- distinct from AdminOrganizersList (which
// only shows accounts that already hold is_organizer=true) and from the
// separate CAC/brand verification queue in AdminVerificationScreen.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { notifyByEmail } from './adminAuditLog';
import { submitOrExecute } from './adminUserEventActions';

export function AdminOrganizerRequestsScreen({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; status: 'approved' | 'rejected'; label: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: reqs, error } = await supabase
        .from('organizer_requests')
        .select('id, user_id, reason, status, admin_note, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const rows = reqs || [];
      const userIds = [...new Set(rows.map((r: any) => r.user_id).filter(Boolean))];
      let usersMap: Record<string, any> = {};
      if (userIds.length > 0) {
        const { data: users } = await supabase.from('users').select('id, username, full_name, email, phone_number, state').in('id', userIds);
        (users || []).forEach((u: any) => { usersMap[u.id] = u; });
      }
      setRequests(rows.map((r: any) => ({ ...r, users: usersMap[r.user_id] || null })));
    } catch (e: any) {
      flash(false, 'Failed to load requests: ' + (e?.message || ''));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (id: string, status: 'approved' | 'rejected') => {
    setBusyId(id);
    const req = requests.find((r) => r.id === id);
    const label = req?.users?.full_name || req?.users?.username || req?.users?.email || req?.user_id;
    const res = await submitOrExecute(isSuperAdmin, 'decide_organizer_request',
      { target_type: 'user', target_id: req?.user_id ?? null, target_label: label, payload: { request_id: id, approve: status === 'approved', reason: null }, previous: { status: 'pending' }, changes: { status } },
      async () => {
        const { error } = await supabase.rpc('admin_decide_organizer_request', { p_request_id: id, p_approve: status === 'approved', p_reason: null });
        if (error) throw error;
        setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
        notifyByEmail('organizer', id, status);
      });
    flash(res.ok, res.message);
    setBusyId(null);
  };

  return (
    <div data-testid="admin-organizer-requests">
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}
      {loading ? (
        <div style={{ textAlign: 'center', color: adminTheme.textFaint, fontSize: 13, padding: 32 }}>Loading…</div>
      ) : requests.length === 0 ? (
        <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 32, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No requests yet.</div>
      ) : requests.map((req: any) => {
        const user = req.users;
        const name = user?.full_name || user?.username || user?.email || req.user_id;
        const statusColor = req.status === 'pending' ? adminTheme.amber : req.status === 'approved' ? adminTheme.green : adminTheme.red;
        return (
          <div key={req.id} style={{ background: adminTheme.panel, borderRadius: 14, padding: 14, marginBottom: 10, border: `1px solid ${adminTheme.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600 }}>{name}</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: `${statusColor}22`, color: statusColor, textTransform: 'uppercase' }}>{req.status}</span>
            </div>
            {(user?.email || user?.phone_number || user?.state) && (
              <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 8px' }}>{[user?.email, user?.phone_number, user?.state].filter(Boolean).join(' · ')}</p>
            )}
            {req.reason && <p style={{ color: adminTheme.textMuted, fontSize: 13, margin: '0 0 10px', lineHeight: 1.4 }}>{req.reason}</p>}
            <p style={{ color: adminTheme.textFainter, fontSize: 11, margin: '0 0 10px' }}>{new Date(req.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
            {req.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={busyId === req.id} onClick={() => setConfirm({ id: req.id, status: 'approved', label: name })} style={{ flex: 1, height: 36, borderRadius: 10, background: 'rgba(52,211,153,.15)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Approve</button>
                <button disabled={busyId === req.id} onClick={() => setConfirm({ id: req.id, status: 'rejected', label: name })} style={{ flex: 1, height: 36, borderRadius: 10, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.25)', color: adminTheme.red, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Reject</button>
              </div>
            )}
          </div>
        );
      })}

      {confirm && (
        <ConfirmModal
          title={confirm.status === 'approved' ? 'Approve Organizer request?' : 'Reject Organizer request?'}
          message={confirm.status === 'approved'
            ? `${confirm.label} will be granted the independent Organizer capability.`
            : `${confirm.label}'s request will be rejected. They keep their current account unchanged.`}
          confirmLabel={confirm.status === 'approved' ? 'Approve' : 'Reject'}
          danger={confirm.status === 'rejected'}
          onConfirm={() => { const c = confirm; setConfirm(null); if (c) decide(c.id, c.status); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
