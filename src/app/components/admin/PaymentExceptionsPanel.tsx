// H1 / OEL-02 (docs/repair-tracker.md, migration 0226): Paystack payments
// that were captured but could not become a ticket (and, from 0233, transfer
// fees that were duplicated, unmatched or of the wrong amount). Every admin
// can see them (admin_list_payment_exceptions).
//
// AZ-10 / owner decision D4 (migration 0234): money goes back only with TWO
// admins. Any admin or sub-admin requests the refund (amount up to what
// Paystack captured, plus a reason); a DIFFERENT Super Admin approves it in
// Admin Actions; only then can a Super Admin send it to Paystack
// (api/wallet/refund-ticket.ts, payment_exception_id), and Paystack's refund
// webhook closes it. The database enforces every step; this panel only
// offers the step that is next. On a database without 0234 the rows carry no
// refund state and the panel behaves exactly as before (record-only).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { apiUrl } from '../../../lib/apiBase';
import { adminTheme } from './adminConsoleTheme';

type ExceptionStatus = 'open' | 'ticket_issued' | 'resolved';
type RefundStatus = 'requested' | 'approved' | 'refund_pending' | 'refund_failed' | 'refunded' | null;
export interface PaymentExceptionRow {
  id: string;
  reference: string;
  reason: 'not_found' | 'amount_mismatch' | 'duplicate_payment' | 'transfer_not_completed' | 'overpayment';
  detail: string | null;
  amount_kobo: number;
  expected_kobo: number | null;
  source: 'verify' | 'webhook' | 'server';
  status: ExceptionStatus;
  resolution_note: string | null;
  resolved_at: string | null;
  seen_count: number;
  first_seen_at: string;
  buyer_username: string | null;
  buyer_email: string | null;
  event_title: string | null;
  // 0233 / 0234 (absent on a database without them).
  kind?: 'ticket_purchase' | 'ticket_transfer_fee';
  refund_status?: RefundStatus;
  refund_amount_kobo?: number | null;
  refund_reason?: string | null;
  refund_requested_by_name?: string | null;
  refund_approved_by_name?: string | null;
  refund_error?: string | null;
  refund_request_status?: 'pending' | 'approved' | 'rejected' | null;
}

const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
const STATUS_LABEL: Record<ExceptionStatus, string> = { open: 'Open', ticket_issued: 'Ticket issued later', resolved: 'Resolved' };

export function reasonText(r: PaymentExceptionRow): string {
  const fee = r.kind === 'ticket_transfer_fee';
  if (r.reason === 'transfer_not_completed') {
    return 'Transfer fee paid, but the ticket transfer could not complete (cancelled, expired or ticket no longer eligible)';
  }
  if (r.reason === 'overpayment') {
    // 0239: the transfer completed; amount_kobo is ONLY the excess (the cap
    // on any refund), expected_kobo the fee.
    return `Transfer fee overpaid: the transfer completed; only the extra ${fmt(r.amount_kobo)} is refundable${r.expected_kobo != null ? ` (fee ${fmt(r.expected_kobo)})` : ''}`;
  }
  if (r.reason === 'duplicate_payment') {
    return fee ? 'Second payment of a ticket-transfer fee that was already paid' : 'Second payment for an order that was already paid';
  }
  if (r.reason === 'amount_mismatch') {
    return `Amount paid (${fmt(r.amount_kobo)}) did not match the ${fee ? 'transfer fee' : 'order'}${r.expected_kobo != null ? ` (${fmt(r.expected_kobo)})` : ''}`;
  }
  if (fee) return r.detail ? `Transfer fee not applied: ${r.detail}` : 'No matching ticket transfer for this payment';
  return r.detail ? `Ticket not issued: ${r.detail}` : 'No matching order for this payment';
}

/** What the refund flow shows for a row; null when the database has no refund flow (before 0234). */
export function refundStage(r: PaymentExceptionRow): string | null {
  if (r.refund_status === undefined) return null;
  const amt = r.refund_amount_kobo != null ? fmt(r.refund_amount_kobo) : '';
  switch (r.refund_status) {
    case 'requested':
      return r.refund_request_status === 'rejected'
        ? `The refund request of ${amt} was rejected in Admin Actions. Request it again if the money is still owed.`
        : `Refund of ${amt} requested by ${r.refund_requested_by_name ?? 'an admin'}: waiting for a different Super Admin to approve it in Admin Actions`;
    case 'approved': return `Refund of ${amt} approved by ${r.refund_requested_by_name ?? 'an admin'} and ${r.refund_approved_by_name ?? 'a Super Admin'}: ready to send to Paystack`;
    case 'refund_pending': return `Refund of ${amt} sent to Paystack: waiting for Paystack to confirm`;
    case 'refunded': return `Refunded ${amt}`;
    case 'refund_failed': return `Refund failed${r.refund_error ? `: ${r.refund_error}` : ''}. The money is still owed; request it again.`;
    default: return 'No refund yet';
  }
}

export function PaymentExceptionsPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [status, setStatus] = useState<ExceptionStatus>('open');
  const [rows, setRows] = useState<PaymentExceptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [requesting, setRequesting] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setRows(null); setError(null);
    const { data, error: e } = await supabase.rpc('admin_list_payment_exceptions' as any, { p_status: status, p_limit: 100, p_offset: 0 });
    if (e) { setError(e.message || 'Could not load payment exceptions.'); setRows([]); return; }
    setRows((data as PaymentExceptionRow[]) || []);
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const resolve = async (id: string) => {
    if (note.trim().length < 5) { setActionError('Add a note of at least 5 characters (for example, the Paystack refund reference).'); return; }
    setSaving(true); setActionError(null);
    const { error: e } = await supabase.rpc('admin_resolve_payment_exception' as any, { p_id: id, p_note: note.trim() });
    setSaving(false);
    if (e) { setActionError(e.message || 'Could not record the resolution.'); return; }
    setResolving(null); setNote('');
    void load();
  };

  const requestRefund = async (r: PaymentExceptionRow) => {
    const naira = Number(amount.replace(/,/g, ''));
    const kobo = Math.round(naira * 100);
    if (!Number.isFinite(naira) || kobo <= 0) { setActionError('Enter an amount greater than zero.'); return; }
    if (kobo > r.amount_kobo) { setActionError(`The refund cannot be more than Paystack captured (${fmt(r.amount_kobo)}).`); return; }
    if (reason.trim().length < 5) { setActionError('Add a reason of at least 5 characters.'); return; }
    if (inFlight.current) return;
    inFlight.current = true; setSaving(true); setActionError(null);
    const { error: e } = await supabase.rpc('admin_request_payment_exception_refund' as any, { p_id: r.id, p_amount_kobo: kobo, p_reason: reason.trim() });
    inFlight.current = false; setSaving(false);
    if (e) { setActionError(e.message || 'Could not request the refund.'); return; }
    setRequesting(null); setAmount(''); setReason('');
    setMessage('Refund requested. A different Super Admin must approve it in Admin Actions before it can be sent.');
    void load();
  };

  const sendRefund = async (r: PaymentExceptionRow) => {
    if (!window.confirm(`Send the approved refund of ${fmt(r.refund_amount_kobo ?? 0)} to Paystack now?`)) return;
    if (inFlight.current) return;
    inFlight.current = true; setSaving(true); setActionError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(apiUrl('/api/v1/wallet/refund-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session?.access_token}` },
        body: JSON.stringify({ payment_exception_id: r.id, reason: r.refund_reason || 'Payment captured without a ticket' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Refund failed');
      setMessage(json.status === 'already_refunded' ? 'This payment was already refunded.' : 'Refund sent to Paystack. It completes when Paystack confirms it.');
    } catch (e: any) {
      setActionError(e?.message || 'Refund failed');
    } finally {
      inFlight.current = false; setSaving(false);
      void load();
    }
  };

  const linkBtn = { alignSelf: 'flex-start' as const, background: 'none', border: 'none', padding: 0, fontSize: 12, fontWeight: 600, cursor: 'pointer' };

  return (
    <div data-testid="payment-exceptions-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted, lineHeight: 1.5 }}>
        Payments Paystack captured that could not become a ticket (or a ticket transfer). A refund needs two admins: one requests it, a different Super Admin approves it in Admin Actions, then it is sent to Paystack.
      </p>
      {message && <div data-testid="payment-exceptions-message" style={{ fontSize: 12, color: adminTheme.green }}>{message}</div>}
      {actionError && requesting === null && resolving === null && <div role="alert" data-testid="payment-exceptions-action-error" style={{ fontSize: 12, color: adminTheme.red }}>{actionError}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['open', 'ticket_issued', 'resolved'] as const).map((s) => (
          <button key={s} data-testid={`payment-exceptions-filter-${s}`} onClick={() => setStatus(s)} style={{ padding: '5px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: status === s ? adminTheme.accentSoftBg : adminTheme.panel, color: status === s ? adminTheme.accentText : adminTheme.textMuted }}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {error && <div role="alert" style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: '10px 14px', color: adminTheme.red, fontSize: 12 }}>{error}</div>}
      {rows === null ? (
        <p style={{ color: adminTheme.textFaint, fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 && !error ? (
        <p data-testid="payment-exceptions-empty" style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>
          {status === 'open' ? 'No open payment exceptions' : `No ${STATUS_LABEL[status].toLowerCase()} exceptions`}
        </p>
      ) : rows.map((r) => {
        const stage = refundStage(r);
        const hasRefundFlow = stage !== null;
        const requestRejected = r.refund_status === 'requested' && r.refund_request_status === 'rejected';
        const canRequest = hasRefundFlow && r.status === 'open' && (r.refund_status == null || r.refund_status === 'refund_failed' || requestRejected);
        // Approved or in flight: Paystack's webhook finishes it. Requested and
        // still waiting: the second admin decides first (the database refuses
        // a hand close in both cases; the panel doesn't offer it).
        const refundBusy = hasRefundFlow && (r.refund_status === 'approved' || r.refund_status === 'refund_pending' || (r.refund_status === 'requested' && !requestRejected));
        const canClose = r.status === 'open' && isSuperAdmin && !refundBusy;
        return (
        <div key={r.id} data-testid="payment-exception-row" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{fmt(r.amount_kobo)}{r.kind === 'ticket_transfer_fee' ? ' · transfer fee' : ''}</span>
            <span style={{ fontSize: 11, color: adminTheme.textMuted }}>{new Date(r.first_seen_at).toLocaleString('en-NG')}{r.seen_count > 1 ? ` · seen ${r.seen_count}×` : ''}</span>
          </div>
          <span style={{ fontSize: 12.5, color: adminTheme.amber }}>{reasonText(r)}</span>
          <span style={{ fontSize: 12, color: adminTheme.text }}>
            {r.buyer_username || r.buyer_email ? `${r.buyer_username ?? ''}${r.buyer_email ? ` · ${r.buyer_email}` : ''}` : 'Buyer unknown'}
            {r.event_title ? ` · ${r.event_title}` : ''}
          </span>
          <span style={{ fontSize: 11, color: adminTheme.textFaint, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{r.reference}</span>
          {stage && <span data-testid="payment-exception-refund-stage" style={{ fontSize: 12, color: adminTheme.textMuted }}>{stage}</span>}
          {r.resolution_note && <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Resolution: {r.resolution_note}</span>}

          {requesting === r.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: adminTheme.textMuted }}>
                Refund amount (₦, at most {fmt(r.amount_kobo)})
                <input data-testid="payment-exception-refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ display: 'block', marginTop: 4, background: adminTheme.panel, color: adminTheme.text, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: 8, fontSize: 12, width: '100%' }} />
              </label>
              <textarea data-testid="payment-exception-refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why this payment is being refunded" style={{ background: adminTheme.panel, color: adminTheme.text, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: 8, fontSize: 12, resize: 'vertical' }} />
              {actionError && <span role="alert" style={{ fontSize: 12, color: adminTheme.red }}>{actionError}</span>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button data-testid="payment-exception-refund-submit" disabled={saving} onClick={() => requestRefund(r)} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: saving ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, background: adminTheme.accentSoftBg, color: adminTheme.accentText }}>{saving ? 'Requesting…' : 'Request refund'}</button>
                <button onClick={() => { setRequesting(null); setActionError(null); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, background: 'none', color: adminTheme.textMuted }}>Cancel</button>
              </div>
            </div>
          ) : resolving === r.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea data-testid="payment-exception-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={hasRefundFlow ? 'Why no refund is needed' : 'How it was resolved (e.g. refunded in Paystack, ref …)'} style={{ background: adminTheme.panel, color: adminTheme.text, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: 8, fontSize: 12, resize: 'vertical' }} />
              {actionError && <span role="alert" style={{ fontSize: 12, color: adminTheme.red }}>{actionError}</span>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button data-testid="payment-exception-save" disabled={saving} onClick={() => resolve(r.id)} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: saving ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, background: adminTheme.accentSoftBg, color: adminTheme.accentText }}>{saving ? 'Saving…' : 'Mark resolved'}</button>
                <button onClick={() => { setResolving(null); setNote(''); setActionError(null); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, background: 'none', color: adminTheme.textMuted }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {canRequest && (
                <button data-testid="payment-exception-request-refund" onClick={() => { setRequesting(r.id); setResolving(null); setAmount((r.amount_kobo / 100).toFixed(2)); setReason(''); setActionError(null); setMessage(null); }} style={{ ...linkBtn, color: adminTheme.blue }}>Request refund</button>
              )}
              {hasRefundFlow && r.refund_status === 'approved' && isSuperAdmin && (
                <button data-testid="payment-exception-send-refund" disabled={saving} onClick={() => sendRefund(r)} style={{ ...linkBtn, color: adminTheme.blue, cursor: saving ? 'wait' : 'pointer' }}>{saving ? 'Sending…' : 'Send refund to Paystack'}</button>
              )}
              {canClose && (
                <button data-testid="payment-exception-resolve" onClick={() => { setResolving(r.id); setRequesting(null); setNote(''); setActionError(null); setMessage(null); }} style={{ ...linkBtn, color: hasRefundFlow ? adminTheme.textMuted : adminTheme.blue }}>{hasRefundFlow ? 'Close without refund' : 'Record resolution'}</button>
              )}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
