// Payouts — ported verbatim from the legacy AdminDashboardScreen.tsx's
// PayoutsTab as part of its full retirement. Covers withdrawal requests
// (Approve & Pay / Cancel / Refund, all with confirmation dialogs already
// built in), Organizer Wallets, and User Wallets. The design export's
// separate "Finance / VENTS Wallet / Payments / Refunds" nav entries all
// point at this one real screen -- the backend has exactly one Payouts
// feature, not four, so no placeholder pages were created to pad out the
// nav to match the export's mock IA.
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { EarningsAdjustmentForm } from './EarningsAdjustmentForm';
import { WithdrawalReassignForm } from './WithdrawalReassignForm';
import { notifyByEmail } from './adminAuditLog';
import { apiUrl } from '../../../lib/apiBase';
import { withTimeoutFallback } from '../../../lib/withTimeoutFallback';
import { Sentry } from '../../../lib/sentry';
import { isBackendUnavailable } from '../../../lib/workRoles';
import {
  fetchAdminWithdrawals, adminFirstApprove, adminSecondApprove, adminCancelFirstApproval,
  stageInfo, STAGE_TONE_COLORS, type AdminWithdrawal,
} from '../../../lib/withdrawals';

// isSuperAdmin only shapes labels and the legacy (pre-0211) view; on 0211
// every button comes from the server's can_* columns for THIS admin.
export function AdminPayoutsScreen({ isSuperAdmin = false }: { isSuperAdmin?: boolean } = {}) {
  const [requests, setRequests] = useState<any[]>([]);
  const [wallets, setWallets] = useState<any[]>([]);
  // 0203: held earnings of one organizer/provider, opened from the wallets list.
  const [holdsFor, setHoldsFor] = useState<string | null>(null);
  const [holds, setHolds] = useState<any[] | null>(null);
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
  const [checkingExceptions, setCheckingExceptions] = useState(false);
  const [showAdjustment, setShowAdjustment] = useState(false);
  const [reassignFor, setReassignFor] = useState<string | null>(null);
  const [exceptionReport, setExceptionReport] = useState<any[] | null>(null);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  const [rejectConfirmId, setRejectConfirmId] = useState<string | null>(null);
  // Audit finding: "Approve & Pay" — the one action here that actually
  // moves real money via Paystack — had no confirmation step at all, unlike
  // Reject/Cancel (both typed-confirmation). A single stray click fired a
  // real transfer immediately. Server-side it's protected from a genuine
  // DUPLICATE transfer (admin_claim_payout_for_processing's atomic
  // compare-and-swap, confirmed live), so this is a misclick safety net,
  // not a duplicate-transfer fix.
  const [approveConfirmId, setApproveConfirmId] = useState<string | null>(null);
  // 0211: true when the rows come from admin_list_withdrawals (one
  // authoritative state for admins and sub-admins); false on a database
  // without 0211 (legacy view below).
  const [authoritative, setAuthoritative] = useState<boolean>(false);
  const [firstApproveRow, setFirstApproveRow] = useState<AdminWithdrawal | null>(null);
  const [secondApproveRow, setSecondApproveRow] = useState<AdminWithdrawal | null>(null);
  const [withdrawFirstRow, setWithdrawFirstRow] = useState<AdminWithdrawal | null>(null);
  // 0203 maker-checker: a withdrawal is paid only after one admin requests
  // authorization and a different super admin approves it (Admin Actions).
  // null = the database has no approval columns yet (0203 not applied); the
  // server is the authority either way -- the claim refuses an unauthorized
  // request.
  const [approvals, setApprovals] = useState<Record<string, { approved: boolean; pendingRequestId: string | null; requestedByMe: boolean }> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };
  // Audit finding: unlike Approve (protected server-side by
  // admin_claim_payout_for_processing's atomic status compare-and-swap),
  // admin_reject_organizer_payout and admin_cancel_processing_payout both
  // do an unlocked SELECT of the current status followed by a SEPARATE
  // UPDATE not reconditioned on that status (confirmed live via
  // pg_get_functiondef) -- a genuine TOCTOU race: two concurrent calls for
  // the same request could both read 'pending'/'processing', both pass,
  // and both refund the organizer's wallet, double-crediting it. That
  // needs a database fix (prepared separately, not applied here). This ref
  // is the only mitigation available without a migration: it closes the
  // client-side half of the race (a double-click on the modal's own
  // Confirm button, which has no busy state of its own) so this app can
  // never be the one that fires the second call.
  const actionInFlightRef = useRef<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 0211: the authoritative list first; the legacy reads only when the
      // database does not have it yet.
      let authoritativeRows: AdminWithdrawal[] | null = null;
      try {
        authoritativeRows = await fetchAdminWithdrawals(statusFilter === 'pending' ? 'open' : 'all');
      } catch (e: any) {
        if (!isBackendUnavailable(e)) throw e;
      }
      setAuthoritative(authoritativeRows !== null);
      const [reqRes, walRes, memberWalRes] = await withTimeoutFallback(
        Promise.all([
          authoritativeRows !== null ? Promise.resolve({ data: authoritativeRows, error: null } as any)
          : statusFilter === 'pending'
            ? supabase.rpc('admin_list_pending_payouts' as any)
            : supabase
                .from('organizer_withdrawal_requests')
                .select('id, organizer_id, amount_kobo, status, created_at, updated_at, admin_note, organizer_bank_accounts(bank_name, account_number, account_name, recipient_code), users!organizer_withdrawal_requests_organizer_id_public_users_fkey(username, full_name, email, phone_number)')
                .order('created_at', { ascending: false })
                .limit(50),
          supabase
            .from('organizer_wallets')
            .select('*')  // '*': includes 0203's on_hold_kobo when present
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
      const pendingIds = normalized.filter((r: any) => r.status === 'pending').map((r: any) => r.request_id);
      if (authoritativeRows !== null) {
        setApprovals(null);
      } else if (pendingIds.length === 0) {
        setApprovals({});
      } else {
        const [{ data: me }, apprRes, actRes] = await Promise.all([
          supabase.auth.getUser(),
          supabase.from('organizer_withdrawal_requests').select('id, approved_by' as any).in('id', pendingIds),
          supabase.from('admin_action_requests').select('id, target_id, requested_by').eq('action_type', 'authorize_withdrawal').eq('status', 'pending').in('target_id', pendingIds),
        ]);
        if (apprRes.error) {
          setApprovals(null);
        } else {
          const map: Record<string, { approved: boolean; pendingRequestId: string | null; requestedByMe: boolean }> = {};
          ((apprRes.data as any[]) || []).forEach((row) => {
            const act = ((actRes.data as any[]) || []).find((a) => a.target_id === row.id);
            map[row.id] = { approved: !!row.approved_by, pendingRequestId: act?.id ?? null, requestedByMe: !!act && act.requested_by === me?.user?.id };
          });
          setApprovals(map);
        }
      }
    } catch (err: any) {
      Sentry.captureException(err);
      setLoadError(err?.message || 'Failed to load payouts.');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [statusFilter]);

  // 0203: open customer disputes of completed bookings. Each is decided by
  // two admins (request here, approve in Admin Actions); until then the
  // provider's earnings for that booking stay held. Empty (and hidden) on a
  // database without 0203.
  const [disputes, setDisputes] = useState<any[]>([]);
  const loadDisputes = async () => {
    const { data, error } = await supabase.from('service_booking_disputes' as any)
      .select('id, booking_id, reason, opened_at, status, resolution_note').in('status', ['open', 'resolved_for_customer'])
      .order('opened_at', { ascending: true }).limit(50);
    setDisputes(error ? [] : ((data as any[]) || []));
  };
  useEffect(() => { loadDisputes(); }, []);
  const requestDisputeResolution = async (d: any, outcome: 'provider' | 'customer') => {
    const note = window.prompt(outcome === 'provider'
      ? 'Why should the provider be paid? (shown to the approving admin)'
      : 'Why is the customer right? (the earnings stay held for a refund)');
    if (!note?.trim()) return;
    const { error } = await supabase.rpc('request_admin_action' as any, {
      p_action_type: 'resolve_booking_dispute', p_target_type: 'booking', p_target_id: d.booking_id,
      p_target_label: `Booking dispute ${String(d.id).slice(0, 8)}`,
      p_payload: { dispute_id: d.id, outcome, note: note.trim() },
    });
    if (error) { flash(false, error.message || 'Could not request the resolution'); return; }
    flash(true, 'Resolution requested — a different super admin must approve it in Admin Actions.');
  };
  // Upheld for the customer (two admins already decided): refund through the
  // existing booking refund path. A VENTS Wallet booking is refunded at once;
  // a Paystack booking goes refund_pending and the refund webhook finishes it.
  // The database refuses a completed booking without an upheld dispute.
  const refundDisputedBooking = async (d: any) => {
    if (!window.confirm('Refund the customer in full for this booking? The provider gives back their earnings for it.')) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = d.booking_id;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(apiUrl('/api/v1/wallet/refund-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session?.access_token}` },
        body: JSON.stringify({ booking_id: d.booking_id, reason: `Dispute upheld: ${d.resolution_note || 'customer complaint'}` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Refund failed');
      flash(true, json.status === 'refund_pending' ? 'Refund sent to Paystack — it completes when Paystack confirms.' : 'Customer refunded.');
      await loadDisputes();
    } catch (e: any) { flash(false, e.message || 'Refund failed'); } finally { actionInFlightRef.current = null; }
  };

  const handleApprove = async (id: string) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = id;
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
    } catch (e: any) { flash(false, e.message || 'Approve failed'); } finally { setActionLoading(null); actionInFlightRef.current = null; }
  };

  const handleRequestAuthorization = async (r: any) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = r.request_id;
    setActionLoading(r.request_id);
    try {
      const { error } = await supabase.rpc('request_admin_action' as any, {
        p_action_type: 'authorize_withdrawal',
        p_target_type: 'withdrawal',
        p_target_id: r.request_id,
        p_target_label: `${r.organizer_name || 'Organizer'} · ${fmt(r.amount_kobo)}`,
        // The approving admin's executor checks this against the request.
        p_payload: { request_id: r.request_id, amount_kobo: r.amount_kobo },
      });
      if (error) throw error;
      await load();
      flash(true, 'Authorization requested — a different super admin must approve it in Admin Actions before it can be paid.');
    } catch (e: any) { flash(false, e.message || 'Could not request authorization'); } finally { setActionLoading(null); actionInFlightRef.current = null; }
  };

  // 0211 two-admin approval. Each call is refused by the server unless THIS
  // admin may do it; the list is re-read afterwards, so what is shown is
  // always the database's state, never an optimistic guess.
  const runWithdrawalAction = async (id: string, fn: () => Promise<void>, ok: string) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = id;
    setActionLoading(id);
    try {
      await fn();
      flash(true, ok);
    } catch (e: any) {
      flash(false, e?.message || 'That action was refused');
    } finally {
      setActionLoading(null);
      actionInFlightRef.current = null;
      await load();
    }
  };

  const handleReject = async (id: string, reason: string) => {
    if (!reason.trim()) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = id;
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
    } catch (e: any) { flash(false, e.message || 'Reject failed'); } finally { setActionLoading(null); actionInFlightRef.current = null; }
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

  // Report-only: transfers Paystack may have paid while VENTS shows the
  // request as cancelled, failed or rejected (2026-07 incident). Changes
  // nothing; resolving one is a two-admin decision.
  const handleCheckExceptions = async () => {
    setCheckingExceptions(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/reconcile-payouts'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: 'exceptions' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Exception check failed');
      setExceptionReport(Array.isArray(json.report) ? json.report : []);
    } catch (e: any) { flash(false, e.message || 'Exception check failed'); } finally { setCheckingExceptions(false); }
  };

  const handleCancelConfirmed = async (id: string, reason: string) => {
    setCancelConfirmId(null);
    if (!reason.trim()) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = id;
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
    } catch (e: any) { flash(false, e.message || 'Cancel failed'); } finally { setActionLoading(null); actionInFlightRef.current = null; }
  };

  const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

  const loadHolds = async (ownerId: string) => {
    setHoldsFor(ownerId);
    setHolds(null);
    const { data, error } = await supabase.rpc('get_earnings_holds' as any, { p_owner: ownerId });
    if (error) { flash(false, error.message || 'Could not load held earnings'); setHolds([]); return; }
    setHolds((data as any[]) || []);
  };
  // Any admin may place a review hold; lifting one needs a super admin who is
  // not the earner (enforced by admin_set_earnings_hold). Both are audited.
  const setEarningsHold = async (holdId: string, hold: boolean) => {
    const reason = window.prompt(hold ? 'Why are these earnings being held?' : 'Why is this hold being lifted?');
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc('admin_set_earnings_hold' as any, { p_hold_id: holdId, p_hold: hold, p_reason: reason.trim() });
    if (error) { flash(false, error.message || 'Could not update the hold'); return; }
    flash(true, hold ? 'Hold placed — these earnings will not be released until it is lifted.' : 'Hold lifted — the earnings release once nothing else blocks them.');
    if (holdsFor) await loadHolds(holdsFor);
  };

  // 0211: the approval trail and the actions THIS admin may take, all from
  // admin_list_withdrawals.
  const authoritativeActions = (r: AdminWithdrawal, marginTop: number) => {
    const busy = actionLoading === r.request_id;
    const btn = (testId: string, label: string, onClick: () => void, tone: 'blue' | 'green' | 'neutral' | 'red') => {
      const c = tone === 'blue' ? { bg: 'rgba(96,165,250,.15)', bd: 'rgba(96,165,250,.3)', fg: adminTheme.blue }
        : tone === 'green' ? { bg: 'rgba(52,211,153,.15)', bd: 'rgba(52,211,153,.3)', fg: adminTheme.green }
        : tone === 'red' ? { bg: 'rgba(248,113,113,.12)', bd: 'rgba(248,113,113,.3)', fg: adminTheme.red }
        : { bg: adminTheme.borderChip, bd: adminTheme.border, fg: adminTheme.text };
      return (
        <button key={testId} data-testid={`${testId}-${r.request_id}`} onClick={onClick} disabled={busy}
          style={{ flex: '1 1 120px', background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 10, padding: 8, color: c.fg, fontWeight: 700, fontSize: 13, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Working…' : label}
        </button>
      );
    };
    const who = (name: string | null, tier: string | null) => `${name || 'An admin'}${tier === 'sub' ? ' (sub-admin)' : tier === 'full' ? ' (admin)' : ''}`;
    const when = (t: string | null) => (t ? new Date(t).toLocaleString('en-NG') : '');
    return (
      <div data-testid={`withdrawal-approvals-${r.request_id}`} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop }}>
        <div style={{ fontSize: 12, color: adminTheme.textMuted, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span data-testid={`withdrawal-first-approval-${r.request_id}`}>
            1st approval: {r.first_approved_by ? <b style={{ color: adminTheme.text }}>{who(r.first_approved_by_name, r.first_approved_by_tier)} · {when(r.first_approved_at)}</b> : 'not yet'}
          </span>
          <span data-testid={`withdrawal-second-approval-${r.request_id}`}>
            2nd approval: {r.second_approved_by ? <b style={{ color: adminTheme.text }}>{who(r.second_approved_by_name, null)} · {when(r.second_approved_at)}</b> : 'not yet'}
          </span>
        </div>
        {r.action_note && (
          <p data-testid={`withdrawal-action-note-${r.request_id}`} style={{ margin: 0, fontSize: 12, color: adminTheme.amber }}>{r.action_note}</p>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.can_first_approve && btn('withdrawal-first-approve', 'Approve (1st)', () => setFirstApproveRow(r), 'blue')}
          {r.can_second_approve && btn('withdrawal-second-approve', 'Approve (2nd)', () => setSecondApproveRow(r), 'blue')}
          {r.can_pay && btn('withdrawal-pay', 'Pay now', () => setApproveConfirmId(r.request_id), 'green')}
          {r.can_cancel_first_approval && btn('withdrawal-withdraw-first', 'Withdraw 1st approval', () => setWithdrawFirstRow(r), 'neutral')}
          {r.can_reject && btn('withdrawal-reject', 'Reject', () => setRejectConfirmId(r.request_id), 'red')}
        </div>
        {r.status === 'pending' && !r.can_reject && !r.action_note && (
          <p style={{ margin: 0, fontSize: 11, color: adminTheme.textFaint }}>Only a full admin can reject a withdrawal.</p>
        )}
        {r.status === 'pending' && !r.second_approved_by && (
          <button data-testid={`withdrawal-reassign-toggle-${r.request_id}`} onClick={() => setReassignFor((v) => (v === r.request_id ? null : r.request_id))} title="If the organizer's bank account was deactivated: move this request to another of their verified accounts (two admins, 0207). Moves no money." style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, color: adminTheme.textMuted, fontSize: 11.5, textDecoration: 'underline', cursor: 'pointer' }}>
            {reassignFor === r.request_id ? 'Hide' : 'Move to another bank account'}
          </button>
        )}
        {reassignFor === r.request_id && <WithdrawalReassignForm requestId={r.request_id} organizerId={r.organizer_id} />}
      </div>
    );
  };

  // Buttons for a pending withdrawal: authorize (two admins) -> pay -> or reject.
  const pendingActions = (r: any, marginTop: number) => {
    if (authoritative && 'stage' in r) return authoritativeActions(r as AdminWithdrawal, marginTop);
    const a = approvals?.[r.request_id];
    const busy = actionLoading === r.request_id || payoutsDisabled;
    const canPay = approvals === null || !!a?.approved;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop }}>
        {approvals !== null && (
          <p data-testid="payout-authorization-state" style={{ margin: 0, fontSize: 12, color: a?.approved ? adminTheme.green : adminTheme.amber }}>
            {a?.approved ? 'Authorized by two admins — ready to pay.'
              : a?.pendingRequestId ? (a.requestedByMe ? 'Authorization requested — waiting for a different super admin to approve it in Admin Actions.' : 'Authorization requested — approve it in Admin Actions.')
              : 'Needs two-admin authorization before it can be paid.'}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {approvals !== null && !a?.approved && !a?.pendingRequestId && (
            <button onClick={() => handleRequestAuthorization(r)} disabled={busy} style={{ flex: 1, background: 'rgba(96,165,250,.15)', border: '1px solid rgba(96,165,250,.3)', borderRadius: 10, padding: 8, color: adminTheme.blue, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              {actionLoading === r.request_id ? 'Requesting…' : 'Request authorization'}
            </button>
          )}
          <button onClick={() => setApproveConfirmId(r.request_id)} disabled={busy || !canPay} title={canPay ? undefined : 'A second admin must authorize this withdrawal first'} style={{ flex: 1, background: 'rgba(52,211,153,.15)', border: '1px solid rgba(52,211,153,.3)', borderRadius: 10, padding: 8, color: adminTheme.green, fontWeight: 700, fontSize: 13, cursor: canPay ? 'pointer' : 'not-allowed', opacity: canPay ? 1 : 0.5 }}>
            {actionLoading === r.request_id ? 'Processing…' : 'Approve & Pay'}
          </button>
          <button onClick={() => setRejectConfirmId(r.request_id)} disabled={busy} title="Rejects the request — funds stay in the platform, nothing is sent to Paystack" style={{ flex: 1, background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: 8, color: adminTheme.text, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Cancel Request</button>
        </div>
        {!a?.approved && (
          <button data-testid={`withdrawal-reassign-toggle-${r.request_id}`} onClick={() => setReassignFor((v) => (v === r.request_id ? null : r.request_id))} title="If the organizer's bank account was deactivated: move this request to another of their verified accounts (two admins, 0207). Moves no money." style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, color: adminTheme.textMuted, fontSize: 11.5, textDecoration: 'underline', cursor: 'pointer' }}>
            {reassignFor === r.request_id ? 'Hide' : 'Move to another bank account'}
          </button>
        )}
        {reassignFor === r.request_id && <WithdrawalReassignForm requestId={r.request_id} organizerId={r.organizer_id} />}
      </div>
    );
  };
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
        <button data-testid="payout-exceptions-check" onClick={handleCheckExceptions} disabled={checkingExceptions} title="Ask Paystack about requests that ended cancelled, failed or rejected while holding a transfer code. Changes nothing." style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(251,191,36,.3)', cursor: checkingExceptions ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12, background: 'rgba(251,191,36,.1)', color: '#FBBF24', opacity: checkingExceptions ? 0.6 : 1 }}>
          {checkingExceptions ? 'Checking…' : 'Check payout exceptions'}
        </button>
        <button data-testid="earnings-adjustment-toggle" onClick={() => setShowAdjustment((v) => !v)} title="File an audited correction for a second admin to approve (0206). Moves nothing by itself." style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${adminTheme.border}`, cursor: 'pointer', fontWeight: 600, fontSize: 12, background: adminTheme.panel, color: adminTheme.textMuted }}>
          {showAdjustment ? 'Hide adjustment form' : 'Request earnings adjustment'}
        </button>
      </div>

      {showAdjustment && <EarningsAdjustmentForm />}

      {exceptionReport && (
        <div data-testid="payout-exceptions-report" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#FBBF24' }}>
            Payout exceptions ({exceptionReport.length}) · report only, nothing was changed
          </p>
          {exceptionReport.length === 0 && <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>None: every transfer code matches its request.</p>}
          {exceptionReport.map((r: any) => (
            <div key={r.request_id} data-testid={`payout-exception-${r.request_id}`} style={{ fontSize: 12, color: adminTheme.textMuted }}>
              <b style={{ color: r.finding === 'paid_not_recorded' ? adminTheme.red : adminTheme.text }}>
                {r.finding === 'paid_not_recorded' ? 'Paid by Paystack, not recorded in VENTS'
                  : r.finding === 'not_paid_consistent' ? 'Not paid (consistent)'
                  : r.finding === 'still_pending_on_paystack' ? 'Still pending on Paystack'
                  : r.finding === 'no_transfer_code' ? 'Recorded exception (no transfer code)'
                  : 'Paystack lookup failed'}
              </b>
              {' · '}{fmt(Number(r.amount_kobo) || 0)}{' · request '}{String(r.request_id).slice(0, 8)}{' · VENTS status '}{r.request_status}
              {r.paystack_status ? ` · Paystack ${r.paystack_status}` : ''}
            </div>
          ))}
          {exceptionReport.some((r: any) => r.finding === 'paid_not_recorded') && (
            <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>
              Resolve with two admins per docs/production-readiness-batch-d.md (payout exceptions). Do not edit these records directly.
            </p>
          )}
        </div>
      )}

      {disputes.length > 0 && (
        <div data-testid="admin-booking-disputes" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: adminTheme.amber }}>Booking disputes ({disputes.length})</p>
          {disputes.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: adminTheme.text }}>
              <span style={{ flex: 1 }}>{new Date(d.opened_at).toLocaleString('en-NG')} · {d.reason}{d.status === 'resolved_for_customer' ? ' · UPHELD' : ''}</span>
              {d.status === 'open' ? (
                <>
                  <button onClick={() => requestDisputeResolution(d, 'provider')} style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '4px 8px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Pay provider</button>
                  <button onClick={() => requestDisputeResolution(d, 'customer')} style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '4px 8px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Uphold customer</button>
                </>
              ) : (
                <button data-testid="dispute-refund" onClick={() => refundDisputedBooking(d)} disabled={payoutsDisabled} style={{ background: 'rgba(248,113,113,.12)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 8, padding: '4px 8px', color: adminTheme.red, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Refund customer</button>
              )}
            </div>
          ))}
        </div>
      )}
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
                {(w.on_hold_kobo ?? 0) > 0 && <span style={{ fontSize: 12, color: adminTheme.textMuted }}>On hold: {fmt(w.on_hold_kobo)}</span>}
                <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Earned: {fmt(w.total_earned_kobo)}</span>
                <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Withdrawn: {fmt(w.total_withdrawn_kobo ?? 0)}</span>
              </div>
              {pendingReq && pendingActions(pendingReq, 2)}
              {(w.on_hold_kobo ?? 0) > 0 && (
                <button onClick={() => (holdsFor === w.organizer_id ? setHoldsFor(null) : loadHolds(w.organizer_id))} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: adminTheme.blue, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {holdsFor === w.organizer_id ? 'Hide held earnings' : 'Held earnings'}
                </button>
              )}
              {holdsFor === w.organizer_id && (
                <div data-testid="admin-earnings-holds" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {holds === null ? <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Loading…</span>
                    : holds.length === 0 ? <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Nothing held.</span>
                    : holds.map((h: any) => {
                      const blockers: string[] = Array.isArray(h.blockers) ? h.blockers : [];
                      const held = blockers.includes('admin_hold') || blockers.includes('payment_dispute');
                      return (
                        <div key={h.hold_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: adminTheme.text }}>
                          <span style={{ flex: 1 }}>
                            {fmt(h.amount_kobo)} · {h.source_kind === 'ticket_sale' ? (h.event_title || 'Ticket sale') : 'Service booking'}
                            {h.release_at ? ` · releases ${new Date(h.release_at).toLocaleString('en-NG')}` : ''}
                            {blockers.filter((b) => b !== 'not_yet').length > 0 ? ` · paused: ${blockers.filter((b) => b !== 'not_yet').join(', ')}` : ''}
                            {h.admin_hold_reason ? ` (${h.admin_hold_reason})` : ''}
                          </span>
                          <button onClick={() => setEarningsHold(h.hold_id, !held)} style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '4px 8px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                            {held ? 'Lift hold' : 'Hold'}
                          </button>
                        </div>
                      );
                    })}
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
            {authoritative && r.stage ? (
              <span data-testid={`withdrawal-stage-${r.request_id}`} style={{ fontSize: 11, fontWeight: 700, color: STAGE_TONE_COLORS[stageInfo(r.stage).tone].fg, background: STAGE_TONE_COLORS[stageInfo(r.stage).tone].bg, borderRadius: 6, padding: '3px 8px' }}>{stageInfo(r.stage).admin.toUpperCase()}</span>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 700, color: statusColor[r.status] || adminTheme.textMuted, background: `${statusColor[r.status]}22`, borderRadius: 6, padding: '3px 8px' }}>{r.status.toUpperCase()}</span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: adminTheme.accentFrom }}>{fmt(r.amount_kobo)}</p>
          {r.bank_name && <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>{r.bank_name} · {r.account_number} · {r.account_name}</p>}
          {r.recipient_code && <p style={{ margin: 0, fontSize: 10, color: adminTheme.textFainter, fontFamily: 'monospace' }}>{r.recipient_code}</p>}
          {authoritative && r.status === 'pending' && r.bank_account_active === false && <p style={{ margin: 0, fontSize: 11, color: adminTheme.red }}>This bank account is no longer active.</p>}
          {authoritative && r.admin_note && r.status !== 'pending' && <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>Note: {r.admin_note}</p>}
          <p style={{ margin: 0, fontSize: 11, color: adminTheme.textFainter }}>{new Date(r.created_at).toLocaleString('en-NG')}</p>
          {r.status === 'pending' && pendingActions(r, 4)}
          {r.status === 'processing' && (
            // 0202: a claimed request has a transfer reference, so only Paystack
            // settles it (webhook or Reconcile). The server refuses a refund
            // unless the request never reached Paystack (older requests only).
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <p data-testid="payout-awaiting-paystack" style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>
              Sent to Paystack — not paid until Paystack confirms. Use Reconcile to settle it.
            </p>
              {(isSuperAdmin || !authoritative) && <button onClick={() => setCancelConfirmId(r.request_id)} disabled={actionLoading === r.request_id || payoutsDisabled} title="Only for an older request that never reached Paystack; the server refuses it otherwise" style={{ flex: 1, background: adminTheme.red, border: '1px solid #F87171', borderRadius: 10, padding: 10, color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>
                {actionLoading === r.request_id ? 'Refunding…' : '⚠ Refund (never sent to Paystack)'}
              </button>}
            </div>
          )}
        </div>
      ))}

      {approveConfirmId && (
        <ConfirmModal
          title={authoritative ? 'Send this withdrawal to the bank?' : 'Approve this payout?'}
          message={authoritative
            ? 'Two different admins approved it. This immediately sends a real transfer to the approved bank account via Paystack. It is marked paid only when Paystack confirms it.'
            : "This will immediately send a real transfer to the organizer's bank account via Paystack. This cannot be undone from here."}
          confirmLabel={authoritative ? 'Pay now' : 'Approve & Pay'} danger typedConfirmationText={authoritative ? 'PAY' : 'APPROVE'} requireReason={false}
          onConfirm={() => { const id = approveConfirmId; setApproveConfirmId(null); handleApprove(id); }}
          onCancel={() => setApproveConfirmId(null)}
        />
      )}
      {firstApproveRow && (
        <ConfirmModal
          title="Give the first approval?"
          message={`${firstApproveRow.organizer_name || 'This user'} asked to withdraw ${fmt(firstApproveRow.amount_kobo)} to ${firstApproveRow.bank_name || 'their bank'} · ${firstApproveRow.account_number || ''} (${firstApproveRow.account_name || ''}). Nothing is paid yet: a different admin must give the second approval, and at least one of you must be a full admin.`}
          confirmLabel="Approve (1st)" danger={false} requireReason={false}
          onConfirm={() => { const r = firstApproveRow; setFirstApproveRow(null); runWithdrawalAction(r.request_id, () => adminFirstApprove(r.request_id, r.amount_kobo), 'First approval recorded — a different admin must give the second.'); }}
          onCancel={() => setFirstApproveRow(null)}
        />
      )}
      {secondApproveRow && (
        <ConfirmModal
          title="Give the second approval?"
          message={`${fmt(secondApproveRow.amount_kobo)} to ${secondApproveRow.bank_name || 'their bank'} · ${secondApproveRow.account_number || ''} (${secondApproveRow.account_name || ''}). First approved by ${secondApproveRow.first_approved_by_name || 'another admin'}. After this it is ready to pay; nothing is sent until someone presses Pay now.`}
          confirmLabel="Approve (2nd)" danger typedConfirmationText="APPROVE" requireReason={false}
          onConfirm={() => { const r = secondApproveRow; setSecondApproveRow(null); runWithdrawalAction(r.request_id, () => adminSecondApprove(r.request_id), 'Second approval recorded — the withdrawal is approved and ready to pay.'); }}
          onCancel={() => setSecondApproveRow(null)}
        />
      )}
      {withdrawFirstRow && (
        <ConfirmModal
          title="Withdraw the first approval?"
          message="The withdrawal goes back to waiting for its first approval. No money moves."
          confirmLabel="Withdraw approval" danger={false} requireReason
          reasonPlaceholder="Why (kept in the audit log)"
          onConfirm={(reason) => { const r = withdrawFirstRow; setWithdrawFirstRow(null); runWithdrawalAction(r.request_id, () => adminCancelFirstApproval(r.request_id, reason || ''), 'First approval withdrawn.'); }}
          onCancel={() => setWithdrawFirstRow(null)}
        />
      )}
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
