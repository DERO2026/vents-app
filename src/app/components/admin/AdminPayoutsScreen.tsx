// Payouts — ported verbatim from the legacy AdminDashboardScreen.tsx's
// PayoutsTab as part of its full retirement. Covers withdrawal requests
// (Approve & Pay / Cancel / Refund, all with confirmation dialogs already
// built in), Organizer Wallets, and User Wallets. The design export's
// separate "Finance / VENTS Wallet / Payments / Refunds" nav entries all
// point at this one real screen -- the backend has exactly one Payouts
// feature, not four, so no placeholder pages were created to pad out the
// nav to match the export's mock IA.
import React, { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { notifyByEmail } from './adminAuditLog';
import { apiUrl } from '../../../lib/apiBase';
import { withTimeoutFallback } from '../../../lib/withTimeoutFallback';
import { Sentry } from '../../../lib/sentry';

export function AdminPayoutsScreen() {
  const [requests, setRequests] = useState<any[]>([]);
  const [wallets, setWallets] = useState<any[]>([]);
  const [memberWallets, setMemberWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [payoutsDisabled, setPayoutsDisabled] = useState(false);
  useEffect(() => {
    supabase.from('app_config').select('disable_payouts').maybeSingle()
      .then(({ data }) => setPayoutsDisabled(!!data?.disable_payouts), () => {});
  }, []);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'requests' | 'wallets' | 'member-wallets'>('requests');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [rejectConfirmId, setRejectConfirmId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [reqRes, walRes, memberWalRes] = await withTimeoutFallback(
        Promise.all([
          statusFilter === 'pending'
            ? supabase.rpc('admin_list_pending_payouts' as any)
            : supabase
                .from('organizer_withdrawal_requests')
                .select('id, organizer_id, amount_kobo, status, created_at, updated_at, admin_note, organizer_bank_accounts(bank_name, account_number, account_name, recipient_code), users!organizer_withdrawal_requests_organizer_id_public_users_fkey(username, full_name, email, phone_number)')
                .order('created_at', { ascending: false })
                .limit(50),
          supabase
            .from('organizer_wallets')
            .select('organizer_id, balance_kobo, pending_kobo, total_earned_kobo, total_withdrawn_kobo')
            .order('balance_kobo', { ascending: false })
            .limit(100),
          supabase
            .from('user_wallets')
            .select('user_id, balance_kobo')
            .order('balance_kobo', { ascending: false })
            .limit(100),
        ]),
        { timeoutMs: 15000, timeoutMessage: 'This is taking longer than expected. Please check your connection and try again.' }
      );
      const { data: reqs, error: reqError } = reqRes;
      const { data: walsRaw, error: walError } = walRes;
      const { data: memberWalsRaw, error: memberWalError } = memberWalRes;
      if (reqError || walError || memberWalError) {
        Sentry.captureException(reqError || walError || memberWalError);
        setLoadError((reqError || walError || memberWalError)?.message || 'Failed to load payouts.');
      }
      let wals = walsRaw || [];
      let memberWals = memberWalsRaw || [];
      const allWalletUserIds = [...wals.map((w: any) => w.organizer_id), ...memberWals.map((w: any) => w.user_id)];
      if (allWalletUserIds.length > 0) {
        const { data: userRows } = await supabase.from('users').select('id, username, full_name').in('id', allWalletUserIds);
        const userMap: Record<string, any> = {};
        (userRows || []).forEach((u: any) => { userMap[u.id] = u; });
        wals = wals.map((w: any) => ({ ...w, users: userMap[w.organizer_id] || null }));
        memberWals = memberWals.map((w: any) => ({ ...w, users: userMap[w.user_id] || null }));
      }
      setMemberWallets(memberWals);
      const normalized = (reqs || []).map((r: any) => {
        if ('request_id' in r) return r;
        const org = r['users!organizer_withdrawal_requests_organizer_id_public_users_fkey'];
        const bank = r.organizer_bank_accounts;
        return {
          request_id: r.id, organizer_id: r.organizer_id,
          organizer_name: org?.full_name || org?.username, organizer_email: org?.email, organizer_phone: org?.phone_number,
          amount_kobo: r.amount_kobo, bank_name: bank?.bank_name, account_number: bank?.account_number,
          account_name: bank?.account_name, recipient_code: bank?.recipient_code, status: r.status, created_at: r.created_at,
        };
      });
      setRequests(normalized);
      setWallets(wals);
    } catch (err: any) {
      Sentry.captureException(err);
      setLoadError(err?.message || 'Failed to load payouts.');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve', request_id: id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Approve failed');
      await load();
      flash(true, 'Transfer initiated — Paystack is processing. Status will update to Completed once confirmed.');
    } catch (e: any) { flash(false, e.message || 'Approve failed'); } finally { setActionLoading(null); }
  };

  const handleReject = async (id: string, reason: string) => {
    if (!reason.trim()) return;
    setActionLoading(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'reject', request_id: id, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Reject failed');
      await load();
      notifyByEmail('payout', id, 'rejected', reason.trim());
      flash(true, 'Payout rejected and funds returned to available balance.');
    } catch (e: any) { flash(false, e.message || 'Reject failed'); } finally { setActionLoading(null); }
  };

  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/reconcile-payouts'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Reconcile failed');
      const resolved = (json.results || []).filter((r: any) => r.outcome === 'completed' || r.outcome === 'failed').length;
      flash(true, `Checked ${json.checked ?? 0} processing payout(s) against Paystack — ${resolved} resolved.`);
      await load();
    } catch (e: any) { flash(false, e.message || 'Reconcile failed'); } finally { setReconciling(false); }
  };

  const handleCancelConfirmed = async (id: string, reason: string) => {
    setCancelConfirmId(null);
    if (!reason.trim()) return;
    setActionLoading(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'cancel', request_id: id, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Cancel failed');
      await load();
      flash(true, 'Payout cancelled and funds returned to available balance.');
    } catch (e: any) { flash(false, e.message || 'Cancel failed'); } finally { setActionLoading(null); }
  };

  const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
  const statusColor: Record<string, string> = { pending: adminTheme.amber, processing: adminTheme.blue, completed: adminTheme.green, failed: adminTheme.red, rejected: adminTheme.red, cancelled: adminTheme.red };
  const totalPending = requests.filter((r) => r.status === 'pending' || r.status === 'processing').reduce((s: number, r: any) => s + r.amount_kobo, 0);
  const pendingByOrganizer: Record<string, any> = {};
  requests.filter((r) => r.status === 'pending').forEach((r) => { pendingByOrganizer[r.organizer_id] = r; });

  return (
    <div data-testid="admin-payouts" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {payoutsDisabled && (
        <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ margin: 0, fontSize: 13, color: adminTheme.red, fontWeight: 700 }}>⚠ Payouts are temporarily disabled platform-wide</p>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: adminTheme.textMuted }}>Approve/Cancel/Refund actions are paused until this kill switch is turned off in System.</p>
        </div>
      )}
      {totalPending > 0 && (
        <div style={{ background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ margin: 0, fontSize: 12, color: adminTheme.amber }}>Total pending payout</p>
          <p style={{ margin: '2px 0 0', fontSize: 20, fontWeight: 800, color: adminTheme.amber }}>{fmt(totalPending)}</p>
        </div>
      )}
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['requests', 'wallets', 'member-wallets'] as const).map((s) => (
          <button key={s} onClick={() => setActiveSection(s)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: activeSection === s ? adminTheme.accentSoftBg : adminTheme.panel, color: activeSection === s ? adminTheme.accentText : adminTheme.textMuted }}>
            {s === 'requests' ? 'Requests' : s === 'wallets' ? 'Organizer Wallets' : 'User Wallets'}
          </button>
        ))}
        <div style={{ width: 1, background: adminTheme.border, margin: '2px 2px' }} />
        {(['pending', 'all'] as const).map((f) => (
          <button key={f} onClick={() => { setStatusFilter(f); setActiveSection('requests'); }} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: activeSection === 'requests' && statusFilter === f ? 'rgba(96,165,250,.15)' : adminTheme.panelAlt, color: activeSection === 'requests' && statusFilter === f ? adminTheme.blue : adminTheme.textFaint }}>
            {f === 'pending' ? 'Pending' : 'All'}
          </button>
        ))}
        <button onClick={handleReconcile} disabled={reconciling} title="Poll Paystack directly for any payout stuck in Processing and resolve it" style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(96,165,250,.3)', cursor: reconciling ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12, background: 'rgba(96,165,250,.1)', color: adminTheme.blue, opacity: reconciling ? 0.6 : 1 }}>
          {reconciling ? 'Reconciling…' : '⟳ Reconcile Processing'}
        </button>
      </div>

      {loadError && <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: '10px 14px', color: adminTheme.red, fontSize: 12 }}>{loadError}</div>}

      {loading ? (
        <p style={{ color: adminTheme.textFaint, fontSize: 13 }}>Loading…</p>
      ) : activeSection === 'member-wallets' ? (
        memberWallets.length === 0 ? <p style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No user wallets yet</p> : memberWallets.map((w: any) => (
          <div key={w.user_id} style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{w.users?.username || w.users?.full_name || w.user_id.slice(0, 8)}</p>
            <span style={{ fontSize: 12, color: adminTheme.accentText }}>Balance: <strong>{fmt(w.balance_kobo)}</strong></span>
          </div>
        ))
      ) : activeSection === 'wallets' ? (
        wallets.length === 0 ? <p style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No organizer wallets yet</p> : wallets.map((w: any) => {
          const u = w.users;
          const pendingReq = (w.pending_kobo ?? 0) > 0 ? pendingByOrganizer[w.organizer_id] : null;
          return (
            <div key={w.organizer_id} style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{u?.username || u?.full_name || w.organizer_id.slice(0, 8)}</p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: adminTheme.accentText }}>Balance: <strong>{fmt(w.balance_kobo)}</strong></span>
                {(w.pending_kobo ?? 0) > 0 && <span style={{ fontSize: 12, color: adminTheme.amber }}>Pending: {fmt(w.pending_kobo)}</span>}
                <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Earned: {fmt(w.total_earned_kobo)}</span>
                <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Withdrawn: {fmt(w.total_withdrawn_kobo ?? 0)}</span>
              </div>
              {pendingReq && (
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  <button onClick={() => handleApprove(pendingReq.request_id)} disabled={actionLoading === pendingReq.request_id || payoutsDisabled} style={{ flex: 1, background: 'rgba(52,211,153,.15)', border: '1px solid rgba(52,211,153,.3)', borderRadius: 10, padding: 8, color: adminTheme.green, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    {actionLoading === pendingReq.request_id ? 'Processing…' : 'Approve & Pay'}
                  </button>
                  <button onClick={() => setRejectConfirmId(pendingReq.request_id)} disabled={actionLoading === pendingReq.request_id || payoutsDisabled} title="Rejects the request — funds stay in the platform, nothing is sent to Paystack" style={{ flex: 1, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: 8, color: adminTheme.text, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Cancel Request</button>
                </div>
              )}
            </div>
          );
        })
      ) : requests.length === 0 ? (
        <p style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No {statusFilter === 'pending' ? 'pending ' : ''}withdrawal requests</p>
      ) : requests.map((r: any) => (
        <div key={r.request_id} style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{r.organizer_name || r.organizer_id?.slice(0, 8)}</p>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: adminTheme.textMuted }}>{r.organizer_email}{r.organizer_phone ? ` · ${r.organizer_phone}` : ''}</p>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: statusColor[r.status] || adminTheme.textMuted, background: `${statusColor[r.status]}22`, borderRadius: 6, padding: '3px 8px' }}>{r.status.toUpperCase()}</span>
          </div>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: adminTheme.accentFrom }}>{fmt(r.amount_kobo)}</p>
          {r.bank_name && <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>{r.bank_name} · {r.account_number} · {r.account_name}</p>}
          {r.recipient_code && <p style={{ margin: 0, fontSize: 10, color: adminTheme.textFainter, fontFamily: 'monospace' }}>{r.recipient_code}</p>}
          <p style={{ margin: 0, fontSize: 11, color: adminTheme.textFainter }}>{new Date(r.created_at).toLocaleString('en-NG')}</p>
          {r.status === 'pending' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={() => handleApprove(r.request_id)} disabled={actionLoading === r.request_id || payoutsDisabled} style={{ flex: 1, background: 'rgba(52,211,153,.15)', border: '1px solid rgba(52,211,153,.3)', borderRadius: 10, padding: 8, color: adminTheme.green, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {actionLoading === r.request_id ? 'Processing…' : 'Approve & Pay'}
              </button>
              <button onClick={() => setRejectConfirmId(r.request_id)} disabled={actionLoading === r.request_id || payoutsDisabled} title="Rejects the request — funds stay in the platform, nothing is sent to Paystack" style={{ flex: 1, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: 8, color: adminTheme.text, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Cancel Request</button>
            </div>
          )}
          {r.status === 'processing' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={() => setCancelConfirmId(r.request_id)} disabled={actionLoading === r.request_id || payoutsDisabled} title="Use this if this request is stuck in Processing and doesn't actually exist on Paystack" style={{ flex: 1, background: adminTheme.red, border: '1px solid #F87171', borderRadius: 10, padding: 10, color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
                {actionLoading === r.request_id ? 'Refunding…' : '⚠ Refund Funds'}
              </button>
            </div>
          )}
        </div>
      ))}

      {rejectConfirmId && (
        <ConfirmModal
          title="Cancel this payout request?"
          message="The request will be rejected and the funds will stay safely in the organizer's platform balance — nothing is sent to Paystack."
          confirmLabel="Cancel request" danger={false} typedConfirmationText="CANCEL" requireReason
          reasonPlaceholder="Reason for rejecting (shown to the organizer)"
          onConfirm={(reason) => { const id = rejectConfirmId; setRejectConfirmId(null); handleReject(id, reason || ''); }}
          onCancel={() => setRejectConfirmId(null)}
        />
      )}
      {cancelConfirmId && (
        <ConfirmModal
          title="Refund this payout?"
          message="This request is already Processing — a transfer may already be in flight with Paystack. Confirming will mark it cancelled and return the funds to the organizer's platform balance."
          confirmLabel="Refund funds" danger typedConfirmationText="REFUND" requireReason
          reasonPlaceholder="Reason for cancelling (required for the audit trail, shown to the organizer)"
          onConfirm={(reason) => { const id = cancelConfirmId; setCancelConfirmId(null); handleCancelConfirmed(id, reason || ''); }}
          onCancel={() => setCancelConfirmId(null)}
        />
      )}
    </div>
  );
}
