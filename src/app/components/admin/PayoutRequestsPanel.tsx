// Payout requests (0213, 0214). The VENTS Admin is the only final payout
// authority: Review (any other admin, optional) -> Approve for Payment
// (VENTS Admin) -> Authorize & Pay (VENTS Admin + 10-digit Admin Payout PIN)
// -> Paystack -> Paid only when Paystack confirms.
//
// Everything shown comes from the database (admin_payout_overview,
// admin_list_withdrawals): totals over every withdrawal, the stage, who acts
// next, why a bank account cannot be paid, and which buttons THIS admin may
// use (every can_* flag mirrors the function that performs the action; the
// server refuses anything else, whatever this screen shows). The list is
// newest first and paged by the server (0214); after every action, on focus
// and every 30 seconds it is re-read, so a new withdrawal appears at the top.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { adminTheme } from './adminConsoleTheme';
import { WithdrawalReassignForm } from './WithdrawalReassignForm';
import { notifyByEmail } from './adminAuditLog';
import { Sentry } from '../../../lib/sentry';
import { isBackendUnavailable } from '../../../lib/workRoles';
import {
  fetchPayoutRequests, fetchPayoutOverview, reviewWithdrawal, approveForPayment, authorizeAndPay,
  fetchAdminPayoutPinStatus, setAdminPayoutPin, adminPinProblem, newPayoutIdempotencyKey,
  rejectPayout, cancelProcessingPayout, reconcilePayout, reconcileOutcomeText, bankProblemText,
  sortNewestFirst, mergePayoutPages, hasPaginatedList, PAYOUT_PAGE_SIZE,
  stageInfo, STAGE_TONE_COLORS, ADMIN_PIN_LENGTH,
  type PayoutRequest, type PayoutOverview, type AdminPayoutPinStatus,
} from '../../../lib/withdrawals';

const fmt = (kobo: number | null | undefined) => '₦' + ((Number(kobo) || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
const when = (t: string | null | undefined) => (t ? new Date(t).toLocaleString('en-NG') : '');
const tierLabel = (t: string) => (t === 'sub' ? 'sub-admin' : 'admin');

const NEXT_ACTION: Record<string, string> = {
  review_or_vents_admin: 'A reviewer (optional) or the VENTS Admin',
  vents_admin: 'The VENTS Admin',
  paystack: 'Paystack confirms the transfer',
};

const OVERVIEW_TILES: { key: string; label: string; stages: string[] }[] = [
  { key: 'review', label: 'Pending review', stages: ['pending_review'] },
  { key: 'awaiting', label: 'Awaiting VENTS Admin', stages: ['forwarded_to_vents_admin', 'rejection_recommended'] },
  { key: 'authorize', label: 'Awaiting final authorization', stages: ['vents_admin_approved'] },
  { key: 'processing', label: 'Processing', stages: ['processing'] },
  { key: 'paid', label: 'Paid', stages: ['paid'] },
  { key: 'rejected', label: 'Rejected', stages: ['rejected'] },
  { key: 'failed', label: 'Failed', stages: ['failed', 'reversed'] },
];

function Modal({ title, children, onClose, testId }: { title: string; children: React.ReactNode; onClose: () => void; testId: string }) {
  return (
    <div data-testid={testId} role="dialog" aria-modal="true" aria-label={title}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}>
      <div style={{ background: '#090514', border: `1px solid ${adminTheme.border}`, borderRadius: 18, padding: '22px 20px', width: '100%', maxWidth: 420, maxHeight: '90dvh', overflowY: 'auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: adminTheme.textStrong, fontSize: 16, fontWeight: 800 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: adminTheme.textMuted, fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: '#060A12', border: `1px solid ${adminTheme.border}`, borderRadius: 10,
  padding: '10px 12px', color: adminTheme.text, fontSize: 14, outline: 'none',
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, color: adminTheme.textMuted, margin: '10px 0 4px', letterSpacing: '0.03em' };

function ActionButton({ testId, label, onClick, tone, disabled }: { testId: string; label: string; onClick: () => void; tone: 'blue' | 'green' | 'red' | 'amber' | 'neutral'; disabled?: boolean }) {
  const c = tone === 'blue' ? { bg: 'rgba(96,165,250,.15)', bd: 'rgba(96,165,250,.3)', fg: adminTheme.blue }
    : tone === 'green' ? { bg: 'rgba(52,211,153,.15)', bd: 'rgba(52,211,153,.3)', fg: adminTheme.green }
    : tone === 'red' ? { bg: 'rgba(248,113,113,.12)', bd: 'rgba(248,113,113,.3)', fg: adminTheme.red }
    : tone === 'amber' ? { bg: 'rgba(251,191,36,.1)', bd: 'rgba(251,191,36,.3)', fg: adminTheme.amber }
    : { bg: adminTheme.borderChip, bd: adminTheme.border, fg: adminTheme.text };
  // 44px: a comfortable touch target; flex-basis 150px gives two per row on a
  // 360px phone and wraps instead of clipping or scrolling sideways.
  return (
    <button data-testid={testId} type="button" onClick={onClick} disabled={disabled}
      style={{ flex: '1 1 150px', minWidth: 0, minHeight: 44, background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 10, padding: '10px 12px', color: c.fg, fontWeight: 700, fontSize: 13, lineHeight: 1.25, whiteSpace: 'normal', cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      {label}
    </button>
  );
}

function Detail({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} style={{ minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', color: adminTheme.textFaint, textTransform: 'uppercase' }}>{label}</p>
      <div style={{ margin: '2px 0 0', fontSize: 12.5, color: adminTheme.text, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

/** What a closed request means and why it has no buttons. */
const FINAL_NOTE: Record<string, string> = {
  completed: 'Paid: Paystack confirmed the transfer. Final; there is nothing left to do.',
  failed: 'Failed: Paystack did not pay it and the money is back in the user\'s available balance. Final; the user can request again.',
  rejected: 'Rejected: nothing was sent and the money is back in the user\'s available balance. Final; the user can request again.',
  cancelled: 'Cancelled: nothing was sent and the money is back in the user\'s available balance. Final.',
  reversed: 'Reversed by Paystack: the money is back in the user\'s available balance. Final.',
};

function PinPanel({ status, onChanged }: { status: AdminPayoutPinStatus | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setOpen(false); setPassword(''); setPin(''); setConfirm(''); setError(null); };
  const submit = async () => {
    const problem = adminPinProblem(pin, confirm);
    if (problem) { setError(problem); return; }
    if (!password) { setError('Enter your account password'); return; }
    setBusy(true); setError(null);
    try {
      await setAdminPayoutPin(password, pin, confirm);
      close();
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not set the Admin Payout PIN');
    } finally {
      setBusy(false); setPassword(''); setPin(''); setConfirm('');
    }
  };
  const state = !status ? 'Loading…'
    : !status.has_pin ? 'Not set: payouts are impossible until you create it'
    : status.must_reset ? 'Locked: reset it with your password'
    : status.locked ? `Locked until ${when(status.locked_until)}`
    : status.payouts_paused_until ? `Set · payouts paused until ${when(status.payouts_paused_until)} (changed recently)`
    : 'Set · required for every payout';
  const bad = !!status && (!status.has_pin || status.locked || status.must_reset);
  return (
    <div data-testid="admin-payout-pin-panel" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 220px' }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: adminTheme.textStrong }}>VENTS Admin Payout PIN</p>
        <p data-testid="admin-payout-pin-state" style={{ margin: '2px 0 0', fontSize: 12, color: bad ? adminTheme.amber : adminTheme.green }}>{state}</p>
      </div>
      <button data-testid="admin-payout-pin-open" onClick={() => setOpen(true)} disabled={!status}
        style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '8px 12px', color: adminTheme.text, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
        {status?.has_pin ? (status.must_reset || status.locked ? 'Reset PIN' : 'Change PIN') : 'Create PIN'}
      </button>
      {open && (
        <Modal title={status?.has_pin ? 'Change or reset the Admin Payout PIN' : 'Create the Admin Payout PIN'} onClose={close} testId="admin-payout-pin-modal">
          <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            10 digits, required for every payout. VENTS never asks for it. Your account password confirms it is you.
            {status?.has_pin ? ' After a change, payouts pause for one hour and you are notified.' : ''}
          </p>
          <label style={labelStyle} htmlFor="apin-password">Account password</label>
          <input id="apin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
          <label style={labelStyle} htmlFor="apin-new">New 10-digit PIN</label>
          <input id="apin-new" type="password" inputMode="numeric" autoComplete="off" maxLength={ADMIN_PIN_LENGTH} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} style={inputStyle} />
          <label style={labelStyle} htmlFor="apin-confirm">Enter it again</label>
          <input id="apin-confirm" type="password" inputMode="numeric" autoComplete="off" maxLength={ADMIN_PIN_LENGTH} value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} style={inputStyle} />
          {error && <p data-testid="admin-payout-pin-error" style={{ margin: '10px 0 0', fontSize: 12, color: adminTheme.red }}>{error}</p>}
          <button data-testid="admin-payout-pin-save" onClick={submit} disabled={busy}
            style={{ marginTop: 14, width: '100%', background: adminTheme.accentTo, border: 'none', borderRadius: 10, padding: 11, color: '#fff', fontWeight: 800, fontSize: 14, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Saving…' : 'Save PIN'}
          </button>
        </Modal>
      )}
    </div>
  );
}

export function PayoutRequestsPanel({ payoutsDisabled, refreshSignal = 0 }: { payoutsDisabled: boolean; refreshSignal?: number }) {
  const [overview, setOverview] = useState<PayoutOverview | null>(null);
  const [rows, setRows] = useState<PayoutRequest[]>([]);
  const [scope, setScope] = useState<'open' | 'closed' | 'all'>('open');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [paging, setPaging] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pinStatus, setPinStatus] = useState<AdminPayoutPinStatus | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const loadedCount = useRef(0);
  const scopeRef = useRef(scope);
  const [reassignFor, setReassignFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [reviewRow, setReviewRow] = useState<PayoutRequest | null>(null);
  const [reviewDecision, setReviewDecision] = useState<'forward' | 'recommend_reject'>('forward');
  const [reviewNote, setReviewNote] = useState('');
  const [approveRow, setApproveRow] = useState<PayoutRequest | null>(null);
  const [approveTyped, setApproveTyped] = useState('');
  const [payRow, setPayRow] = useState<PayoutRequest | null>(null);
  const [payPin, setPayPin] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const payKey = useRef<string | null>(null);
  const [rejectRow, setRejectRow] = useState<PayoutRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [cancelRow, setCancelRow] = useState<PayoutRequest | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const modalOpen = !!(reviewRow || approveRow || payRow || rejectRow || cancelRow);
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 8000); };

  // Re-reads the first page (or as many rows as are already loaded, so a
  // refresh never drops what "Load more" showed). Newest first, from the server.
  const load = useCallback(async (opts: { quiet?: boolean; reset?: boolean } = {}) => {
    if (!opts.quiet) setLoading(true);
    setLoadError(null);
    const limit = opts.reset ? PAYOUT_PAGE_SIZE : Math.min(500, Math.max(PAYOUT_PAGE_SIZE, loadedCount.current));
    const forScope = scope;
    try {
      const [ov, first] = await Promise.all([fetchPayoutOverview(), fetchPayoutRequests(forScope, { limit })]);
      let list = first;
      // A backend without 0214 orders open requests OLDEST first and cannot
      // page: a 50-row page would hide the newest ones. Read up to its
      // maximum (500) instead, then sort here.
      if (!hasPaginatedList(first) && first.length >= limit && limit < 500) {
        list = await fetchPayoutRequests(forScope, { limit: 500 });
      }
      if (scopeRef.current !== forScope) return;
      const supports = hasPaginatedList(list);
      setOverview(ov); setRows(sortNewestFirst(list)); setUnavailable(false);
      loadedCount.current = list.length;
      setPaging(supports);
      setHasMore(supports && list.length >= limit);
      if (ov.is_vents_admin) {
        fetchAdminPayoutPinStatus().then(setPinStatus, () => setPinStatus(null));
      }
    } catch (e: any) {
      if (isBackendUnavailable(e)) { setUnavailable(true); }
      else { Sentry.captureException(e); setLoadError(e?.message || 'Failed to load payout requests.'); }
    } finally { if (!opts.quiet) setLoading(false); }
  }, [scope]);
  useEffect(() => { scopeRef.current = scope; loadedCount.current = 0; setRows([]); load({ reset: true }); }, [scope, load]);
  useEffect(() => { if (refreshSignal > 0) load({ quiet: true }); }, [refreshSignal, load]);
  // New withdrawals show up without a manual refresh: on focus and every 30 s
  // while visible, never while a dialog is open or an action is running.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (modalOpenRef.current || inFlight.current) return;
      load({ quiet: true });
    };
    const id = setInterval(tick, 30000);
    window.addEventListener('focus', tick);
    return () => { clearInterval(id); window.removeEventListener('focus', tick); };
  }, [load]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    const forScope = scope;
    try {
      const page = await fetchPayoutRequests(forScope, { limit: PAYOUT_PAGE_SIZE, before: { created_at: last.created_at, request_id: last.request_id } });
      if (scopeRef.current !== forScope) return;
      setRows((cur) => { const merged = mergePayoutPages(cur, page); loadedCount.current = merged.length; return merged; });
      setHasMore(page.length >= PAYOUT_PAGE_SIZE);
    } catch (e: any) {
      Sentry.captureException(e);
      flash(false, e?.message || 'Could not load more requests');
    } finally { setLoadingMore(false); }
  };

  const run = async (id: string, fn: () => Promise<string | void>, ok: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusyId(id);
    try { const text = await fn(); flash(true, text || ok); } catch (e: any) { flash(false, e?.message || 'That action was refused'); }
    finally { inFlight.current = false; setBusyId(null); await load({ quiet: true }); }
  };

  const openReview = (r: PayoutRequest) => {
    setReviewRow(r); setReviewNote('');
    setReviewDecision(r.can_forward === false ? 'recommend_reject' : 'forward');
  };
  const submitReview = () => {
    const r = reviewRow; if (!r) return;
    const note = reviewNote.trim();
    if (note.length < 3) return;
    if (reviewDecision === 'forward' && r.can_forward === false) return;
    setReviewRow(null); setReviewNote('');
    run(r.request_id, () => reviewWithdrawal(r.request_id, r.amount_kobo, reviewDecision, note),
      reviewDecision === 'forward' ? 'Review recorded and forwarded to the VENTS Admin.' : 'Review recorded: rejection recommended to the VENTS Admin.');
  };
  const submitApprove = () => {
    const r = approveRow; if (!r || approveTyped.trim().toUpperCase() !== 'APPROVE') return;
    setApproveRow(null); setApproveTyped('');
    run(r.request_id, () => approveForPayment(r.request_id, r.amount_kobo),
      'Approved for payment. Nothing is sent until you Authorize & Pay with your Admin Payout PIN.');
  };
  const submitPay = async () => {
    const r = payRow; if (!r) return;
    if (!/^\d{10}$/.test(payPin)) { setPayError('Enter the 10-digit Admin Payout PIN'); return; }
    if (inFlight.current) return;
    inFlight.current = true; setBusyId(r.request_id); setPayError(null);
    if (!payKey.current) payKey.current = newPayoutIdempotencyKey();
    const pin = payPin;
    setPayPin('');
    try {
      const res = await authorizeAndPay(r.request_id, r.amount_kobo, pin, payKey.current);
      if (res.ok) {
        payKey.current = null; setPayRow(null);
        flash(true, `Transfer sent to Paystack (reference ${res.reference}). It is marked paid only when Paystack confirms it.`);
      } else if (res.code === 'replayed') {
        payKey.current = null; setPayRow(null);
        flash(true, res.message || 'Already authorized; no second transfer was sent.');
      } else {
        setPayError(res.message || 'Payout not authorized');
        if (res.code && !['wrong_pin', 'pin_format'].includes(res.code)) payKey.current = null;
      }
    } catch (e: any) {
      // Network failure: the key is kept, so retrying cannot send a second transfer.
      setPayError(`${e?.message || 'Network error'}. Nothing new is sent if you retry; use Check with Paystack first.`);
    } finally { inFlight.current = false; setBusyId(null); await load({ quiet: true }); }
  };
  const submitReject = () => {
    const r = rejectRow; const reason = rejectReason.trim(); if (!r || !reason) return;
    setRejectRow(null); setRejectReason('');
    run(r.request_id, async () => {
      await rejectPayout(r.request_id, reason);
      notifyByEmail('payout', r.request_id, 'rejected', reason);
    }, 'Rejected. The money is back in the user\'s available balance and they were told why.');
  };
  const submitCancel = () => {
    const r = cancelRow; const reason = cancelReason.trim(); if (!r || !reason) return;
    setCancelRow(null); setCancelReason('');
    run(r.request_id, () => cancelProcessingPayout(r.request_id, reason),
      'Cancelled. Nothing was sent to Paystack; the money is back in the user\'s available balance.');
  };
  const checkPaystack = (r: PayoutRequest) => {
    run(r.request_id, async () => reconcileOutcomeText(await reconcilePayout(r.request_id)), 'Checked with Paystack.');
  };
  const copyReference = async (r: PayoutRequest) => {
    try { await navigator.clipboard.writeText(r.withdrawal_reference); flash(true, `Reference ${r.withdrawal_reference} copied.`); }
    catch { flash(false, `Copy failed. The reference is ${r.withdrawal_reference}.`); }
  };

  if (unavailable) {
    return <p data-testid="payouts-unavailable" style={{ color: adminTheme.amber, fontSize: 13 }}>The payout system is being upgraded. Try again in a few minutes.</p>;
  }

  const stageSum = (stages: string[]) => stages.reduce((a, s) => {
    const v = overview?.stages?.[s as keyof PayoutOverview['stages']];
    return { count: a.count + (v?.count || 0), amount: a.amount + (Number(v?.amount_kobo) || 0) };
  }, { count: 0, amount: 0 });
  const isRoot = !!overview?.is_vents_admin;

  return (
    <div data-testid="payout-requests" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, maxWidth: '100%' }}>
      {overview && (
        <div data-testid="payout-overview" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 8 }}>
            <div style={{ background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 12, padding: '10px 14px' }}>
              <p style={{ margin: 0, fontSize: 11, color: adminTheme.amber }}>Outstanding withdrawals</p>
              <p data-testid="payout-outstanding" style={{ margin: '2px 0 0', fontSize: 19, fontWeight: 800, color: adminTheme.amber }}>{fmt(overview.outstanding_kobo)}</p>
              <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>{overview.outstanding_count} request{overview.outstanding_count === 1 ? '' : 's'} · pending + processing</p>
            </div>
            <div style={{ background: adminTheme.panelAlt, borderRadius: 12, padding: '10px 14px' }}>
              <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>Processing now</p>
              <p data-testid="payout-processing-total" style={{ margin: '2px 0 0', fontSize: 17, fontWeight: 800, color: adminTheme.blue }}>{fmt(overview.processing_kobo)}</p>
            </div>
            <div style={{ background: adminTheme.panelAlt, borderRadius: 12, padding: '10px 14px' }}>
              <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>Paid in total</p>
              <p data-testid="payout-paid-total" style={{ margin: '2px 0 0', fontSize: 17, fontWeight: 800, color: adminTheme.green }}>{fmt(overview.paid_kobo)}</p>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))', gap: 6 }}>
            {OVERVIEW_TILES.map((t) => {
              const v = stageSum(t.stages);
              return (
                <div key={t.key} data-testid={`payout-tile-${t.key}`} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '8px 10px' }}>
                  <p style={{ margin: 0, fontSize: 10.5, color: adminTheme.textMuted }}>{t.label}</p>
                  <p style={{ margin: '1px 0 0', fontSize: 14, fontWeight: 800, color: adminTheme.text }}>{v.count}</p>
                  <p style={{ margin: 0, fontSize: 10.5, color: adminTheme.textFaint }}>{fmt(v.amount)}</p>
                </div>
              );
            })}
          </div>
          <p style={{ margin: 0, fontSize: 10.5, color: adminTheme.textFainter }}>
            Computed by the server over every withdrawal at {when(overview.computed_at)}.
            {overview.viewer_tier === 'root' ? ' You are the VENTS Admin: you approve and pay.' : overview.viewer_tier === 'sub' ? ' Sub-admin: you can review, forward and recommend rejection; only the VENTS Admin pays.' : ' Admin: you can review, forward and reject; only the VENTS Admin pays.'}
          </p>
        </div>
      )}

      {isRoot && <PinPanel status={pinStatus} onChanged={() => { flash(true, 'Admin Payout PIN saved. You were notified.'); load({ quiet: true }); }} />}
      {msg && <div data-testid="payout-message" role="status" style={{ fontSize: 12.5, color: msg.ok ? adminTheme.green : adminTheme.red }}>{msg.text}</div>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {(['open', 'closed', 'all'] as const).map((s) => (
          <button key={s} type="button" data-testid={`payout-scope-${s}`} aria-pressed={scope === s} onClick={() => setScope(s)}
            style={{ minHeight: 36, padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: scope === s ? 'rgba(96,165,250,.15)' : adminTheme.panelAlt, color: scope === s ? adminTheme.blue : adminTheme.textFaint }}>
            {s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : 'All'}
          </button>
        ))}
        <span data-testid="payout-order-note" style={{ fontSize: 11, color: adminTheme.textFaint }}>Newest first</span>
      </div>

      {loadError && <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: '10px 14px', color: adminTheme.red, fontSize: 12 }}>{loadError}</div>}
      {loading && rows.length === 0 ? (
        <p style={{ color: adminTheme.textFaint, fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No {scope === 'open' ? 'open ' : scope === 'closed' ? 'closed ' : ''}withdrawal requests</p>
      ) : rows.map((r) => {
        const info = stageInfo(r.stage);
        const tone = STAGE_TONE_COLORS[info.tone];
        const busy = busyId === r.request_id || payoutsDisabled;
        const bankOk = r.bank_account_active && r.account_verified && !r.bank_problem;
        const problem = bankProblemText(r.bank_problem ?? (r.status === 'pending' && !(r.bank_account_active && r.account_verified) ? (!r.bank_account_active ? 'inactive' : 'unverified') : null));
        const finalNote = FINAL_NOTE[r.status];
        const canBankChange = r.can_request_bank_change ?? (r.status === 'pending' && !r.approved_by && (r.can_reject || isRoot));
        const anyAction = r.can_review || r.can_approve || r.can_authorize_pay || r.can_reject || r.can_reconcile || r.can_cancel || canBankChange;
        const showAllHistory = !!expanded[r.request_id];
        const reviews = showAllHistory ? r.reviews : r.reviews.slice(-2);
        return (
          <article key={r.request_id} data-testid={`payout-card-${r.request_id}`} aria-label={`Withdrawal ${fmt(r.amount_kobo)} by ${r.organizer_name || 'user'}`}
            style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', overflowWrap: 'anywhere', border: problem ? '1px solid rgba(248,113,113,.35)' : '1px solid transparent' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: '1 1 160px' }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{r.organizer_name || r.organizer_id.slice(0, 8)}</p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: adminTheme.textMuted }}>{r.organizer_email}{r.organizer_phone ? ` · ${r.organizer_phone}` : ''}</p>
              </div>
              <span data-testid={`payout-stage-${r.request_id}`} style={{ flexShrink: 0, maxWidth: '100%', fontSize: 10.5, fontWeight: 700, color: tone.fg, background: tone.bg, borderRadius: 6, padding: '3px 8px' }}>{info.admin.toUpperCase()}</span>
            </div>
            <p data-testid={`payout-amount-${r.request_id}`} style={{ margin: 0, fontSize: 22, fontWeight: 800, color: adminTheme.accentFrom }}>{fmt(r.amount_kobo)}</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: '8px 14px' }}>
              <Detail label="Bank account" testId={`payout-bank-${r.request_id}`}>
                {r.bank_name || 'Bank'} · {r.account_number || r.account_number_masked || '—'}<br />
                <span style={{ color: adminTheme.textMuted }}>{r.account_name || 'name unknown'}</span>
              </Detail>
              <Detail label="Verification" testId={`payout-verification-${r.request_id}`}>
                <span style={{ color: bankOk ? adminTheme.green : adminTheme.red, fontWeight: 700 }}>
                  {bankOk ? '✓ Active · Paystack-verified'
                    : r.bank_problem === 'missing' ? '✗ No bank account'
                    : r.bank_problem === 'changed_since_approval' ? '✗ Changed since approval'
                    : !r.bank_account_active ? '✗ Inactive account' : '✗ Not verified by Paystack'}
                </span>
              </Detail>
              <Detail label="Requested" testId={`payout-date-${r.request_id}`}>{when(r.created_at)}</Detail>
              <Detail label="Reference" testId={`payout-ref-${r.request_id}`}><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.withdrawal_reference}</span></Detail>
              <Detail label="Wallet balance" testId={`payout-wallet-${r.request_id}`}>
                {r.wallet_balance_kobo !== null ? <>{fmt(r.wallet_balance_kobo)} available<br /><span style={{ color: adminTheme.textMuted }}>{fmt(r.wallet_pending_kobo)} pending (includes this request while open)</span></> : '—'}
              </Detail>
              {r.next_action && <Detail label="Next step" testId={`payout-next-${r.request_id}`}><span style={{ color: adminTheme.blue }}>{NEXT_ACTION[r.next_action] || r.next_action}</span></Detail>}
            </div>

            {problem && (
              <div data-testid={`payout-bank-problem-${r.request_id}`} role="alert" style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: '8px 10px', fontSize: 12, color: adminTheme.red, lineHeight: 1.45 }}>
                <b>Transfer blocked.</b> {problem}{' '}
                <span style={{ color: adminTheme.textMuted }}>
                  {r.can_reject ? 'You can reject it (the money returns to the user) or move it to another verified account of the same user.'
                    : r.can_review ? 'You can recommend rejection or request a move to another verified account; the VENTS Admin decides.'
                    : 'Nothing will be sent until this is fixed.'}
                </span>
              </div>
            )}

            <div data-testid={`payout-history-${r.request_id}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, borderLeft: `2px solid ${adminTheme.border}`, paddingLeft: 8 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', color: adminTheme.textFaint, textTransform: 'uppercase' }}>Review history</span>
              {r.reviews.length === 0 ? (
                <span style={{ fontSize: 11.5, color: adminTheme.textFaint }}>No review (optional)</span>
              ) : reviews.map((v, i) => (
                <span key={i} style={{ fontSize: 11.5, color: v.current ? adminTheme.text : adminTheme.textFaint }}>
                  <b>{v.reviewer_name}</b> ({tierLabel(v.reviewer_tier)}) {v.decision === 'forwarded' ? 'forwarded to VENTS Admin' : 'recommends rejection'} · {when(v.created_at)}
                  {!v.current ? ' · outdated (amount or bank changed)' : ''}
                  <br /><span style={{ color: adminTheme.textMuted }}>“{v.note}”</span>
                </span>
              ))}
              {r.reviews.length > 2 && (
                <button type="button" data-testid={`payout-history-toggle-${r.request_id}`} onClick={() => setExpanded((e) => ({ ...e, [r.request_id]: !e[r.request_id] }))}
                  style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: '4px 0', color: adminTheme.blue, fontSize: 11.5, cursor: 'pointer' }}>
                  {showAllHistory ? 'Show latest only' : `Show all ${r.reviews.length} reviews`}
                </button>
              )}
              {r.approved_by && (
                <span data-testid={`payout-approval-${r.request_id}`} style={{ fontSize: 11.5, color: adminTheme.text }}>
                  Approved for payment by <b>{r.approved_by_name || 'VENTS Admin'}</b>{r.approved_at ? ` · ${when(r.approved_at)}` : ''}{!r.approval_current ? ' · bank changed since' : ''}
                </span>
              )}
              {r.authorized_at && (
                <span style={{ fontSize: 11.5, color: adminTheme.text }}>PIN-authorized by <b>{r.authorized_by_name || 'VENTS Admin'}</b>{r.authorized_at ? ` · ${when(r.authorized_at)}` : ''}</span>
              )}
              {r.admin_note && r.status !== 'pending' && <span style={{ fontSize: 11.5, color: adminTheme.red }}>Reason: {r.admin_note}</span>}
            </div>

            {r.pin_required && <p style={{ margin: 0, fontSize: 11.5, color: adminTheme.amber }}>Payment needs the VENTS Admin's 10-digit Admin Payout PIN.</p>}

            <footer data-testid={`payout-footer-${r.request_id}`} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${adminTheme.border}`, paddingTop: 10 }}>
              {((problem ? null : r.action_note) || finalNote) && <p data-testid={`payout-note-${r.request_id}`} style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted, lineHeight: 1.45 }}>{(problem ? null : r.action_note) || finalNote}</p>}
              {anyAction ? (
                <div data-testid={`payout-actions-${r.request_id}`} role="group" aria-label="Actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {r.can_review && <ActionButton testId={`payout-review-${r.request_id}`} label="Review" tone="neutral" disabled={busy} onClick={() => openReview(r)} />}
                  {r.can_approve && <ActionButton testId={`payout-approve-${r.request_id}`} label="Approve for Payment" tone="blue" disabled={busy} onClick={() => { setApproveRow(r); setApproveTyped(''); }} />}
                  {r.can_authorize_pay && <ActionButton testId={`payout-pay-${r.request_id}`} label="Authorize & Pay" tone="green" disabled={busy} onClick={() => { setPayRow(r); setPayPin(''); setPayError(null); payKey.current = null; }} />}
                  {r.can_reconcile && <ActionButton testId={`payout-reconcile-${r.request_id}`} label={busyId === r.request_id ? 'Checking…' : 'Check with Paystack'} tone="blue" disabled={busyId === r.request_id} onClick={() => checkPaystack(r)} />}
                  {canBankChange && <ActionButton testId={`withdrawal-reassign-toggle-${r.request_id}`} label={reassignFor === r.request_id ? 'Hide bank change' : 'Move to another bank account'} tone="amber" onClick={() => setReassignFor((v) => (v === r.request_id ? null : r.request_id))} />}
                  {r.can_cancel && <ActionButton testId={`payout-cancel-${r.request_id}`} label="Cancel (never sent)" tone="red" disabled={busy} onClick={() => { setCancelRow(r); setCancelReason(''); }} />}
                  {r.can_reject && <ActionButton testId={`payout-reject-${r.request_id}`} label="Reject" tone="red" disabled={busy} onClick={() => { setRejectRow(r); setRejectReason(''); }} />}
                </div>
              ) : (
                <p data-testid={`payout-no-actions-${r.request_id}`} style={{ margin: 0, fontSize: 11.5, color: adminTheme.textFaint }}>
                  {finalNote ? 'No actions: this request is closed.' : r.status === 'processing' ? 'No actions for your role while Paystack processes it.' : 'No actions for your role on this request.'}
                </p>
              )}
              {payoutsDisabled && (r.can_review || r.can_approve || r.can_authorize_pay || r.can_reject || r.can_cancel) && <p style={{ margin: 0, fontSize: 11.5, color: adminTheme.red }}>Payouts are paused platform-wide (kill switch): these buttons are disabled until it is turned off.</p>}
              <button type="button" data-testid={`payout-copy-ref-${r.request_id}`} onClick={() => copyReference(r)}
                style={{ alignSelf: 'flex-start', minHeight: 32, background: 'none', border: 'none', padding: '4px 0', color: adminTheme.textMuted, fontSize: 11.5, textDecoration: 'underline', cursor: 'pointer' }}>
                Copy reference
              </button>
              {reassignFor === r.request_id && <WithdrawalReassignForm requestId={r.request_id} organizerId={r.organizer_id} />}
            </footer>
          </article>
        );
      })}

      {rows.length > 0 && (hasMore ? (
        <button type="button" data-testid="payout-load-more" onClick={loadMore} disabled={loadingMore}
          style={{ minHeight: 44, background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 10, color: adminTheme.text, fontWeight: 700, fontSize: 13, cursor: loadingMore ? 'wait' : 'pointer' }}>
          {loadingMore ? 'Loading…' : `Load ${PAYOUT_PAGE_SIZE} older requests`}
        </button>
      ) : (
        <p data-testid="payout-list-end" style={{ margin: 0, textAlign: 'center', fontSize: 11, color: adminTheme.textFainter }}>
          {paging ? `All ${rows.length} ${scope === 'all' ? '' : scope + ' '}request${rows.length === 1 ? '' : 's'} shown.` : `Showing the newest ${rows.length}. Older pages need the 0214 database update.`}
        </p>
      ))}

      {reviewRow && (
        <Modal title="Review withdrawal" onClose={() => setReviewRow(null)} testId="payout-review-modal">
          <p style={{ margin: 0, fontSize: 12.5, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            {reviewRow.organizer_name || 'This user'} · {fmt(reviewRow.amount_kobo)} to {reviewRow.bank_name} · {reviewRow.account_number || reviewRow.account_number_masked} ({reviewRow.account_name}).
            Your review is advisory and kept in the history; only the VENTS Admin approves and pays.
          </p>
          <label style={labelStyle}>Decision</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['forward', 'recommend_reject'] as const).map((d) => {
              const blocked = d === 'forward' && reviewRow.can_forward === false;
              return (
                <button key={d} type="button" data-testid={`payout-review-decision-${d}`} onClick={() => !blocked && setReviewDecision(d)} disabled={blocked}
                  style={{ flex: '1 1 140px', minHeight: 44, padding: 9, borderRadius: 10, cursor: blocked ? 'not-allowed' : 'pointer', fontSize: 12.5, fontWeight: 700, border: `1px solid ${reviewDecision === d ? adminTheme.accentSoftBorder : adminTheme.border}`, background: reviewDecision === d ? adminTheme.accentSoftBg : 'transparent', color: adminTheme.text, opacity: blocked ? 0.45 : 1 }}>
                  {d === 'forward' ? 'Forward to VENTS Admin' : 'Recommend rejection'}
                </button>
              );
            })}
          </div>
          {reviewRow.can_forward === false && (
            <p data-testid="payout-review-forward-blocked" style={{ margin: '8px 0 0', fontSize: 11.5, color: adminTheme.red, lineHeight: 1.45 }}>
              It cannot be forwarded: {bankProblemText(reviewRow.bank_problem) || 'the bank account is inactive or not verified by Paystack.'}
            </p>
          )}
          <label style={labelStyle} htmlFor="payout-review-note">Review notes (required)</label>
          <textarea id="payout-review-note" data-testid="payout-review-note" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={3} maxLength={1000} style={{ ...inputStyle, resize: 'vertical' }} placeholder="What you checked: beneficiary, bank account, amount, history" />
          <button data-testid="payout-review-submit" onClick={submitReview} disabled={reviewNote.trim().length < 3}
            style={{ marginTop: 12, width: '100%', minHeight: 44, background: adminTheme.accentTo, border: 'none', borderRadius: 10, padding: 11, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: reviewNote.trim().length < 3 ? 0.5 : 1 }}>
            Submit review
          </button>
        </Modal>
      )}

      {approveRow && (
        <Modal title="Approve for payment?" onClose={() => setApproveRow(null)} testId="payout-approve-modal">
          <p style={{ margin: 0, fontSize: 12.5, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            {fmt(approveRow.amount_kobo)} to {approveRow.bank_name} · {approveRow.account_number || approveRow.account_number_masked} ({approveRow.account_name}).
            {approveRow.reviews.length === 0 ? ' No one has reviewed it: you are approving it directly.' : ` ${approveRow.reviews.length} review${approveRow.reviews.length === 1 ? '' : 's'} on record above.`}
            {' '}Nothing is sent yet: payment needs Authorize & Pay with your PIN.
          </p>
          <label style={labelStyle} htmlFor="payout-approve-typed">Type APPROVE to confirm</label>
          <input id="payout-approve-typed" data-testid="payout-approve-typed" value={approveTyped} onChange={(e) => setApproveTyped(e.target.value)} placeholder="APPROVE" style={inputStyle} />
          <button data-testid="payout-approve-submit" onClick={submitApprove} disabled={approveTyped.trim().toUpperCase() !== 'APPROVE'}
            style={{ marginTop: 12, width: '100%', minHeight: 44, background: adminTheme.blue, border: 'none', borderRadius: 10, padding: 11, color: '#06101f', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: approveTyped.trim().toUpperCase() !== 'APPROVE' ? 0.5 : 1 }}>
            Approve for Payment
          </button>
        </Modal>
      )}

      {payRow && (
        <Modal title="Authorize & Pay" onClose={() => { setPayRow(null); setPayPin(''); payKey.current = null; }} testId="payout-pay-modal">
          <p style={{ margin: 0, fontSize: 13, color: adminTheme.text, lineHeight: 1.5 }}>
            Send <b>{fmt(payRow.amount_kobo)}</b> to <b>{payRow.account_name}</b>, {payRow.bank_name} · {payRow.account_number || payRow.account_number_masked}.
          </p>
          <p style={{ margin: '6px 0 0', fontSize: 11.5, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            Your PIN authorizes this one withdrawal, this amount and this bank account only. A real Paystack transfer starts immediately; it is marked paid only when Paystack confirms it.
          </p>
          <label style={labelStyle} htmlFor="payout-pay-pin">10-digit Admin Payout PIN</label>
          <input id="payout-pay-pin" data-testid="payout-pay-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={ADMIN_PIN_LENGTH}
            value={payPin} onChange={(e) => setPayPin(e.target.value.replace(/\D/g, ''))} style={{ ...inputStyle, letterSpacing: '0.3em', fontSize: 18 }} />
          {payError && <p data-testid="payout-pay-error" style={{ margin: '10px 0 0', fontSize: 12, color: adminTheme.red }}>{payError}</p>}
          <button data-testid="payout-pay-submit" onClick={submitPay} disabled={payPin.length !== ADMIN_PIN_LENGTH || busyId === payRow.request_id}
            style={{ marginTop: 12, width: '100%', minHeight: 44, background: adminTheme.green, border: 'none', borderRadius: 10, padding: 11, color: '#04150e', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: payPin.length !== ADMIN_PIN_LENGTH ? 0.5 : 1 }}>
            {busyId === payRow.request_id ? 'Authorizing…' : 'Authorize & Pay'}
          </button>
        </Modal>
      )}

      {rejectRow && (
        <Modal title="Reject withdrawal?" onClose={() => setRejectRow(null)} testId="payout-reject-modal">
          <p style={{ margin: 0, fontSize: 12.5, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            {fmt(rejectRow.amount_kobo)} goes back to {rejectRow.organizer_name || 'the user'}'s available balance. Nothing is sent to Paystack. They see your reason.
          </p>
          <label style={labelStyle} htmlFor="payout-reject-reason">Reason (shown to the user)</label>
          <textarea id="payout-reject-reason" data-testid="payout-reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} maxLength={500} style={{ ...inputStyle, resize: 'vertical' }} />
          <button data-testid="payout-reject-submit" onClick={submitReject} disabled={!rejectReason.trim()}
            style={{ marginTop: 12, width: '100%', minHeight: 44, background: adminTheme.red, border: 'none', borderRadius: 10, padding: 11, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: rejectReason.trim() ? 1 : 0.5 }}>
            Reject
          </button>
        </Modal>
      )}

      {cancelRow && (
        <Modal title="Cancel this withdrawal?" onClose={() => setCancelRow(null)} testId="payout-cancel-modal">
          <p style={{ margin: 0, fontSize: 12.5, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            It is stuck in Processing but never reached Paystack (no transfer code or reference). {fmt(cancelRow.amount_kobo)} goes back to {cancelRow.organizer_name || 'the user'}'s available balance.
            The server refuses this if a Paystack transfer could exist; then use Check with Paystack.
          </p>
          <label style={labelStyle} htmlFor="payout-cancel-reason">Reason (shown to the user)</label>
          <textarea id="payout-cancel-reason" data-testid="payout-cancel-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} maxLength={500} style={{ ...inputStyle, resize: 'vertical' }} />
          <button data-testid="payout-cancel-submit" onClick={submitCancel} disabled={!cancelReason.trim()}
            style={{ marginTop: 12, width: '100%', minHeight: 44, background: adminTheme.red, border: 'none', borderRadius: 10, padding: 11, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: cancelReason.trim() ? 1 : 0.5 }}>
            Cancel withdrawal
          </button>
        </Modal>
      )}
    </div>
  );
}
