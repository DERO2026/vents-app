// H1 / OEL-02 (docs/repair-tracker.md, migration 0226): Paystack ticket
// payments that were captured but could not become a ticket. Every admin
// can see them (admin_list_payment_exceptions); an Admin/Root can record
// how one was resolved (admin_resolve_payment_exception: note required,
// written to admin_logs). Recording only -- this panel never refunds or
// moves money. How these refunds are authorized is owner decision D4.
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';

type ExceptionStatus = 'open' | 'ticket_issued' | 'resolved';
export interface PaymentExceptionRow {
  id: string;
  reference: string;
  reason: 'not_found' | 'amount_mismatch';
  detail: string | null;
  amount_kobo: number;
  expected_kobo: number | null;
  source: 'verify' | 'webhook';
  status: ExceptionStatus;
  resolution_note: string | null;
  resolved_at: string | null;
  seen_count: number;
  first_seen_at: string;
  buyer_username: string | null;
  buyer_email: string | null;
  event_title: string | null;
}

const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
const STATUS_LABEL: Record<ExceptionStatus, string> = { open: 'Open', ticket_issued: 'Ticket issued later', resolved: 'Resolved' };

export function reasonText(r: PaymentExceptionRow): string {
  if (r.reason === 'amount_mismatch') {
    return `Amount paid (${fmt(r.amount_kobo)}) did not match the order${r.expected_kobo != null ? ` (${fmt(r.expected_kobo)})` : ''}`;
  }
  return r.detail ? `Ticket not issued: ${r.detail}` : 'No matching order for this payment';
}

export function PaymentExceptionsPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [status, setStatus] = useState<ExceptionStatus>('open');
  const [rows, setRows] = useState<PaymentExceptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  return (
    <div data-testid="payment-exceptions-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted, lineHeight: 1.5 }}>
        Ticket payments Paystack captured that could not become a ticket. Nothing here refunds money: refund in Paystack, then record it here.
      </p>
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
      ) : rows.map((r) => (
        <div key={r.id} data-testid="payment-exception-row" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{fmt(r.amount_kobo)}</span>
            <span style={{ fontSize: 11, color: adminTheme.textMuted }}>{new Date(r.first_seen_at).toLocaleString('en-NG')}{r.seen_count > 1 ? ` · seen ${r.seen_count}×` : ''}</span>
          </div>
          <span style={{ fontSize: 12.5, color: adminTheme.amber }}>{reasonText(r)}</span>
          <span style={{ fontSize: 12, color: adminTheme.text }}>
            {r.buyer_username || r.buyer_email ? `${r.buyer_username ?? ''}${r.buyer_email ? ` · ${r.buyer_email}` : ''}` : 'Buyer unknown'}
            {r.event_title ? ` · ${r.event_title}` : ''}
          </span>
          <span style={{ fontSize: 11, color: adminTheme.textFaint, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{r.reference}</span>
          {r.resolution_note && <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Resolution: {r.resolution_note}</span>}
          {r.status === 'open' && isSuperAdmin && (resolving === r.id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea data-testid="payment-exception-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="How it was resolved (e.g. refunded in Paystack, ref …)" style={{ background: adminTheme.panel, color: adminTheme.text, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: 8, fontSize: 12, resize: 'vertical' }} />
              {actionError && <span role="alert" style={{ fontSize: 12, color: adminTheme.red }}>{actionError}</span>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button data-testid="payment-exception-save" disabled={saving} onClick={() => resolve(r.id)} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: saving ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, background: adminTheme.accentSoftBg, color: adminTheme.accentText }}>{saving ? 'Saving…' : 'Mark resolved'}</button>
                <button onClick={() => { setResolving(null); setNote(''); setActionError(null); }} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, background: 'none', color: adminTheme.textMuted }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button data-testid="payment-exception-resolve" onClick={() => { setResolving(r.id); setNote(''); setActionError(null); }} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: adminTheme.blue, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Record resolution</button>
          ))}
        </div>
      ))}
    </div>
  );
}
