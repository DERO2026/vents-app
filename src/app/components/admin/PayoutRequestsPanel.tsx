// Payout requests (0213). The VENTS Admin is the only final payout
// authority: Review (any other admin, optional) -> Approve for Payment
// (VENTS Admin) -> Authorize & Pay (VENTS Admin + 10-digit Admin Payout PIN)
// -> Paystack -> Paid only when Paystack confirms.
//
// Everything shown comes from the database (admin_payout_overview,
// admin_list_withdrawals): totals over every withdrawal, the stage, who acts
// next, and which buttons THIS admin may use. The server refuses anything
// else, whatever this screen shows. After every action the list is re-read.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { adminTheme } from './adminConsoleTheme';
import { WithdrawalReassignForm } from './WithdrawalReassignForm';
import { notifyByEmail } from './adminAuditLog';
import { apiUrl } from '../../../lib/apiBase';
import { supabase } from '../../../lib/supabase';
import { Sentry } from '../../../lib/sentry';
import { isBackendUnavailable } from '../../../lib/workRoles';
import {
  fetchPayoutRequests, fetchPayoutOverview, reviewWithdrawal, approveForPayment, authorizeAndPay,
  fetchAdminPayoutPinStatus, setAdminPayoutPin, adminPinProblem, newPayoutIdempotencyKey,
  stageInfo, STAGE_TONE_COLORS, ADMIN_PIN_LENGTH,
  type PayoutRequest, type PayoutOverview, type AdminPayoutPinStatus,
} from '../../../lib/withdrawals';

const fmt = (kobo: number | null | undefined) => '₦' + ((Number(kobo) || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
const when = (t: string | null | undefined) => (t ? new Date(t).toLocaleString('en-NG') : '');
const tierLabel = (t: string) => (t === 'sub' ? 'sub-admin' : 'admin');

const NEXT_ACTION: Record<string, string> = {
  review_or_vents_admin: 'Next: a reviewer (optional) or the VENTS Admin',
  vents_admin: 'Next: the VENTS Admin',
  paystack: 'Next: Paystack confirms the transfer',
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

function ActionButton({ testId, label, onClick, tone, disabled }: { testId: string; label: string; onClick: () => void; tone: 'blue' | 'green' | 'red' | 'neutral'; disabled?: boolean }) {
  const c = tone === 'blue' ? { bg: 'rgba(96,165,250,.15)', bd: 'rgba(96,165,250,.3)', fg: adminTheme.blue }
    : tone === 'green' ? { bg: 'rgba(52,211,153,.15)', bd: 'rgba(52,211,153,.3)', fg: adminTheme.green }
    : tone === 'red' ? { bg: 'rgba(248,113,113,.12)', bd: 'rgba(248,113,113,.3)', fg: adminTheme.red }
    : { bg: adminTheme.borderChip, bd: adminTheme.border, fg: adminTheme.text };
  return (
    <button data-testid={testId} onClick={onClick} disabled={disabled}
      style={{ flex: '1 1 140px', background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 10, padding: '9px 10px', color: c.fg, fontWeight: 700, fontSize: 13, cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      {label}
    </button>
  );
}

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

export function PayoutRequestsPanel({ payoutsDisabled }: { payoutsDisabled: boolean }) {
  const [overview, setOverview] = useState<PayoutOverview | null>(null);
  const [rows, setRows] = useState<PayoutRequest[]>([]);
  const [scope, setScope] = useState<'open' | 'closed' | 'all'>('open');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pinStatus, setPinStatus] = useState<AdminPayoutPinStatus | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [reassignFor, setReassignFor] = useState<string | null>(null);

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

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 6000); };

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const [ov, list] = await Promise.all([fetchPayoutOverview(), fetchPayoutRequests(scope)]);
      setOverview(ov); setRows(list); setUnavailable(false);
      if (ov.is_vents_admin) {
        fetchAdminPayoutPinStatus().then(setPinStatus, () => setPinStatus(null));
      }
    } catch (e: any) {
      if (isBackendUnavailable(e)) { setUnavailable(true); }
      else { Sentry.captureException(e); setLoadError(e?.message || 'Failed to load payout requests.'); }
    } finally { setLoading(false); }
  }, [scope]);
  useEffect(() => { load(); }, [load]);

  const run = async (id: string, fn: () => Promise<void>, ok: string) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusyId(id);
    try { await fn(); flash(true, ok); } catch (e: any) { flash(false, e?.message || 'That action was refused'); }
    finally { inFlight.current = false; setBusyId(null); await load(); }
  };

  const submitReview = () => {
    const r = reviewRow; if (!r) return;
    const note = reviewNote.trim();
    if (note.length < 3) return;
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
      setPayError(`${e?.message || 'Network error'}. Nothing new is sent if you retry; check Reconcile first.`);
    } finally { inFlight.current = false; setBusyId(null); await load(); }
  };
  const submitReject = () => {
    const r = rejectRow; const reason = rejectReason.trim(); if (!r || !reason) return;
    setRejectRow(null); setRejectReason('');
    run(r.request_id, async () => {
      const { data } = await supabase.auth.getSession();
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
        body: JSON.stringify({ action: 'reject', request_id: r.request_id, reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Reject failed');
      notifyByEmail('payout', r.request_id, 'rejected', reason);
    }, 'Rejected. The money is back in the user\'s available balance and they were told why.');
  };

  if (unavailable) {
    return <p data-testid="payouts-unavailable" style={{ color: adminTheme.amber, fontSize: 13 }}>The payout system is being upgraded. Try again in a few minutes.</p>;
  }

  const stageSum = (stages: string[]) => stages.reduce((a, s) => {
    const v = overview?.stages?.[s as keyof PayoutOverview['stages']];
    return { count: a.count + (v?.count || 0), amount: a.amount + (Number(v?.amount_kobo) || 0) };
  }, { count: 0, amount: 0 });

  return (
    <div data-testid="payout-requests" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {overview && (
        <div data-testid="payout-overview" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 }}>
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
            {overview.viewer_tier === 'root' ? ' You are the VENTS Admin: you approve and pay.' : overview.viewer_tier === 'sub' ? ' Sub-admin: you can review and forward; only the VENTS Admin pays.' : ' Admin: you can review, forward and reject; only the VENTS Admin pays.'}
          </p>
        </div>
      )}

      {overview?.is_vents_admin && <PinPanel status={pinStatus} onChanged={() => { flash(true, 'Admin Payout PIN saved. You were notified.'); load(); }} />}
      {msg && <div data-testid="payout-message" style={{ fontSize: 12.5, color: msg.ok ? adminTheme.green : adminTheme.red }}>{msg.text}</div>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['open', 'closed', 'all'] as const).map((s) => (
          <button key={s} data-testid={`payout-scope-${s}`} onClick={() => setScope(s)}
            style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: scope === s ? 'rgba(96,165,250,.15)' : adminTheme.panelAlt, color: scope === s ? adminTheme.blue : adminTheme.textFaint }}>
            {s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : 'All'}
          </button>
        ))}
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
        return (
          <div key={r.request_id} data-testid={`payout-card-${r.request_id}`} style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, overflowWrap: 'anywhere' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{r.organizer_name || r.organizer_id.slice(0, 8)}</p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: adminTheme.textMuted }}>{r.organizer_email}{r.organizer_phone ? ` · ${r.organizer_phone}` : ''}</p>
              </div>
              <span data-testid={`payout-stage-${r.request_id}`} style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: tone.fg, background: tone.bg, borderRadius: 6, padding: '3px 8px', textAlign: 'right' }}>{info.admin.toUpperCase()}</span>
            </div>
            <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: adminTheme.accentFrom }}>{fmt(r.amount_kobo)}</p>
            <p data-testid={`payout-bank-${r.request_id}`} style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>
              {r.bank_name || 'Bank'} · {r.account_number || r.account_number_masked || '—'} · {r.account_name || 'name unknown'}
              {' · '}
              <span style={{ color: r.bank_account_active && r.account_verified ? adminTheme.green : adminTheme.red }}>
                {r.bank_account_active && r.account_verified ? 'Paystack-verified account' : 'account inactive or unverified'}
              </span>
            </p>
            <p style={{ margin: 0, fontSize: 11, color: adminTheme.textFaint }}>
              Requested {when(r.created_at)} · ref <span style={{ fontFamily: 'monospace' }}>{r.withdrawal_reference}</span>
              {r.wallet_balance_kobo !== null ? ` · wallet ${fmt(r.wallet_balance_kobo)} available, ${fmt(r.wallet_pending_kobo)} pending` : ''}
            </p>
            {r.next_action && <p data-testid={`payout-next-${r.request_id}`} style={{ margin: 0, fontSize: 11.5, color: adminTheme.blue }}>{NEXT_ACTION[r.next_action] || r.next_action}</p>}

            <div data-testid={`payout-history-${r.request_id}`} style={{ display: 'flex', flexDirection: 'column', gap: 3, borderLeft: `2px solid ${adminTheme.border}`, paddingLeft: 8, marginTop: 2 }}>
              {r.reviews.length === 0 ? (
                <span style={{ fontSize: 11.5, color: adminTheme.textFaint }}>No review (optional)</span>
              ) : r.reviews.map((v, i) => (
                <span key={i} style={{ fontSize: 11.5, color: v.current ? adminTheme.text : adminTheme.textFaint }}>
                  <b>{v.reviewer_name}</b> ({tierLabel(v.reviewer_tier)}) {v.decision === 'forwarded' ? 'forwarded to VENTS Admin' : 'recommends rejection'} · {when(v.created_at)}
                  {!v.current ? ' · outdated (amount or bank changed)' : ''}
                  <br /><span style={{ color: adminTheme.textMuted }}>“{v.note}”</span>
                </span>
              ))}
              {r.approved_by && (
                <span data-testid={`payout-approval-${r.request_id}`} style={{ fontSize: 11.5, color: adminTheme.text }}>
                  Approved for payment by <b>{r.approved_by_name || 'VENTS Admin'}</b> · {when(r.approved_at)}{!r.approval_current ? ' · bank changed since' : ''}
                </span>
              )}
              {r.authorized_at && (
                <span style={{ fontSize: 11.5, color: adminTheme.text }}>PIN-authorized by <b>{r.authorized_by_name || 'VENTS Admin'}</b> · {when(r.authorized_at)}</span>
              )}
              {r.admin_note && r.status !== 'pending' && <span style={{ fontSize: 11.5, color: adminTheme.red }}>Reason: {r.admin_note}</span>}
            </div>

            {r.pin_required && <p style={{ margin: 0, fontSize: 11.5, color: adminTheme.amber }}>Payment needs the VENTS Admin's 10-digit Admin Payout PIN.</p>}
            {r.action_note && <p data-testid={`payout-note-${r.request_id}`} style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>{r.action_note}</p>}

            {(r.can_review || r.can_approve || r.can_authorize_pay || r.can_reject) && (
              <div data-testid={`payout-actions-${r.request_id}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {r.can_review && <ActionButton testId={`payout-review-${r.request_id}`} label="Review" tone="neutral" disabled={busy} onClick={() => { setReviewRow(r); setReviewDecision('forward'); setReviewNote(''); }} />}
                {r.can_approve && <ActionButton testId={`payout-approve-${r.request_id}`} label="Approve for Payment" tone="blue" disabled={busy} onClick={() => { setApproveRow(r); setApproveTyped(''); }} />}
                {r.can_authorize_pay && <ActionButton testId={`payout-pay-${r.request_id}`} label="Authorize & Pay" tone="green" disabled={busy} onClick={() => { setPayRow(r); setPayPin(''); setPayError(null); payKey.current = null; }} />}
                {r.can_reject && <ActionButton testId={`payout-reject-${r.request_id}`} label="Reject" tone="red" disabled={busy} onClick={() => { setRejectRow(r); setRejectReason(''); }} />}
              </div>
            )}
            {r.status === 'pending' && !r.approved_by && (r.can_reject || overview?.is_vents_admin) && (
              <button data-testid={`withdrawal-reassign-toggle-${r.request_id}`} onClick={() => setReassignFor((v) => (v === r.request_id ? null : r.request_id))} style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, color: adminTheme.textMuted, fontSize: 11.5, textDecoration: 'underline', cursor: 'pointer' }}>
                {reassignFor === r.request_id ? 'Hide' : 'Move to another bank account'}
              </button>
            )}
            {reassignFor === r.request_id && <WithdrawalReassignForm requestId={r.request_id} organizerId={r.organizer_id} />}
          </div>
        );
      })}

      {reviewRow && (
        <Modal title="Review withdrawal" onClose={() => setReviewRow(null)} testId="payout-review-modal">
          <p style={{ margin: 0, fontSize: 12.5, color: adminTheme.textMuted, lineHeight: 1.5 }}>
            {reviewRow.organizer_name || 'This user'} · {fmt(reviewRow.amount_kobo)} to {reviewRow.bank_name} · {reviewRow.account_number || reviewRow.account_number_masked} ({reviewRow.account_name}).
            Your review is advisory and kept in the history; only the VENTS Admin approves and pays.
          </p>
          <label style={labelStyle}>Decision</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['forward', 'recommend_reject'] as const).map((d) => (
              <button key={d} data-testid={`payout-review-decision-${d}`} onClick={() => setReviewDecision(d)}
                style={{ flex: '1 1 140px', padding: 9, borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, border: `1px solid ${reviewDecision === d ? adminTheme.accentSoftBorder : adminTheme.border}`, background: reviewDecision === d ? adminTheme.accentSoftBg : 'transparent', color: adminTheme.text }}>
                {d === 'forward' ? 'Forward to VENTS Admin' : 'Recommend rejection'}
              </button>
            ))}
          </div>
          <label style={labelStyle} htmlFor="payout-review-note">Review notes (required)</label>
          <textarea id="payout-review-note" data-testid="payout-review-note" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={3} maxLength={1000} style={{ ...inputStyle, resize: 'vertical' }} placeholder="What you checked: beneficiary, bank account, amount, history" />
          <button data-testid="payout-review-submit" onClick={submitReview} disabled={reviewNote.trim().length < 3}
            style={{ marginTop: 12, width: '100%', background: adminTheme.accentTo, border: 'none', borderRadius: 10, padding: 11, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: reviewNote.trim().length < 3 ? 0.5 : 1 }}>
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
            style={{ marginTop: 12, width: '100%', background: adminTheme.blue, border: 'none', borderRadius: 10, padding: 11, color: '#06101f', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: approveTyped.trim().toUpperCase() !== 'APPROVE' ? 0.5 : 1 }}>
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
            style={{ marginTop: 12, width: '100%', background: adminTheme.green, border: 'none', borderRadius: 10, padding: 11, color: '#04150e', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: payPin.length !== ADMIN_PIN_LENGTH ? 0.5 : 1 }}>
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
            style={{ marginTop: 12, width: '100%', background: adminTheme.red, border: 'none', borderRadius: 10, padding: 11, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer', opacity: rejectReason.trim() ? 1 : 0.5 }}>
            Reject
          </button>
        </Modal>
      )}
    </div>
  );
}
