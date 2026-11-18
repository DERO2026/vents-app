// Admin → Cancellations (migration 0218). Organizers request an event
// cancellation; a Super Admin approves or rejects it (the server records who
// and when, refuses the organizer deciding their own event, and serializes
// concurrent decisions). Approving takes the event off sale and queues a
// refund for every paid ticket. "Process refunds" sends each queued ticket
// through the existing refund path (refund_ticket → Paystack → webhook);
// amounts are always the server's. Nothing here marks a refund done: the
// rows below are the database's view of each ticket.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { adminTheme, accentStrongFill } from './adminConsoleTheme';
import {
  adminListEventCancellations, adminGetEventCancellation, adminDecideEventCancellation,
  processCancellationRefunds, CANCELLATION_STATUS_LABEL, type CancellationStatus,
} from '../../../lib/eventCancellation';

const naira = (kobo: number | null | undefined) =>
  kobo == null ? '—' : `₦${(Number(kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const card: React.CSSProperties = { background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 16, display: 'grid', gap: 10 };
const h: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong };
const muted: React.CSSProperties = { fontSize: 12, color: adminTheme.textMuted };
const btn = (ghost?: boolean): React.CSSProperties => ({
  minHeight: 36, padding: '6px 12px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  ...(ghost ? { background: 'transparent', color: adminTheme.text, border: `1px solid ${adminTheme.borderChip}` } : { background: accentStrongFill, color: '#fff', border: 'none' }),
});
const FILTERS: { key: CancellationStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'requested', label: 'To review' }, { key: 'attention', label: 'Needs attention' },
  { key: 'processing', label: 'Processing' }, { key: 'completed', label: 'Completed' }, { key: 'rejected', label: 'Rejected' },
];
const REFUND_LABEL: Record<string, string> = {
  queued: 'Queued', processing: 'Processing', refunded: 'Refunded', failed: 'Failed · will retry', blocked: 'Needs a manual decision',
};

export function AdminCancellationsScreen({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [filter, setFilter] = useState<CancellationStatus | 'all'>('all');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await adminListEventCancellations(filter === 'all' ? undefined : filter)); }
    catch (e: any) { setError(e.message); setRows([]); }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  if (selected) return <CancellationDetail id={selected} isSuperAdmin={isSuperAdmin} onBack={() => { setSelected(null); void load(); }} />;

  return (
    <div style={{ display: 'grid', gap: 14, padding: 16 }} data-testid="admin-cancellations">
      <div style={card}>
        <h3 style={h}>Event cancellations</h3>
        <div style={muted}>Organizers request a cancellation; a Super Admin approves or rejects it. Approval takes the event off sale and refunds every paid ticket through the normal refund path.</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <button key={f.key} data-testid={`cancellations-filter-${f.key}`} onClick={() => setFilter(f.key)}
              style={{ ...btn(filter !== f.key), minHeight: 32 }}>{f.label}</button>
          ))}
        </div>
      </div>
      {error && <div role="alert" style={{ ...card, color: adminTheme.red }}>{error}</div>}
      {rows === null ? <div style={muted}>Loading…</div> : rows.length === 0 ? (
        <div style={{ ...card, ...muted }} data-testid="cancellations-empty">No cancellation requests here.</div>
      ) : rows.map((r) => (
        <button key={r.id} data-testid={`cancellation-row-${r.id}`} onClick={() => setSelected(r.id)}
          style={{ ...card, textAlign: 'left', cursor: 'pointer', color: adminTheme.text }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{r.event_title}</strong>
            <span style={{ fontSize: 12, color: r.status === 'attention' ? adminTheme.amber : adminTheme.textMuted }}>{CANCELLATION_STATUS_LABEL[r.status as CancellationStatus] ?? r.status}</span>
          </div>
          <div style={muted}>
            {r.organizer_name || 'Organizer'} · requested {new Date(r.requested_at).toLocaleString()} · {r.obligations?.paid_tickets ?? 0} paid ticket(s)
            {r.refunds?.total ? ` · refunds ${r.refunds.refunded}/${r.refunds.total}` : ''}
            {r.refunds?.needs_attention ? ` · ${r.refunds.needs_attention} need attention` : ''}
          </div>
        </button>
      ))}
    </div>
  );
}

function CancellationDetail({ id, isSuperAdmin, onBack }: { id: string; isSuperAdmin: boolean; onBack: () => void }) {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try { setD(await adminGetEventCancellation(id)); } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<string>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMsg(null); setError(null);
    try { setMsg(await fn()); } catch (e: any) { setError(e.message); }
    finally { inFlight.current = false; setBusy(false); setConfirming(null); await load(); }
  };

  if (error && !d) return <div style={{ padding: 16 }}><button style={btn(true)} onClick={onBack}>← Back</button><div role="alert" style={{ ...card, marginTop: 12, color: adminTheme.red }}>{error}</div></div>;
  if (!d) return <div style={{ padding: 16, ...muted }}>Loading…</div>;
  const r = d.request; const o = d.obligations || {}; const pay = d.payments || {};
  const canProcess = r.status === 'processing' || r.status === 'attention';

  return (
    <div style={{ display: 'grid', gap: 14, padding: 16 }} data-testid="admin-cancellation-detail">
      <div><button style={btn(true)} onClick={onBack}>← All cancellations</button></div>
      <div style={card}>
        <h3 style={h}>{d.event?.title}</h3>
        <div data-testid="cancellation-status" style={{ fontSize: 13, color: r.status === 'attention' ? adminTheme.amber : adminTheme.text }}>{CANCELLATION_STATUS_LABEL[r.status as CancellationStatus] ?? r.status}</div>
        <div style={muted}>Organizer: {d.organizer?.name || '—'} · Event date {d.event?.event_date ? new Date(d.event.event_date).toLocaleString() : '—'}</div>
        <div style={{ fontSize: 13 }}><strong>Reason:</strong> {r.reason}</div>
        <div style={muted}>Requested {new Date(r.requested_at).toLocaleString()}{r.decided_at ? ` · decided ${new Date(r.decided_at).toLocaleString()}` : ''}{r.decision_note ? ` · note: ${r.decision_note}` : ''}</div>
      </div>

      <div style={card} data-testid="cancellation-money">
        <h3 style={h}>Tickets and refunds (server amounts)</h3>
        <div style={{ fontSize: 13 }}>{o.paid_tickets ?? 0} paid · {o.refund_pending ?? 0} refund pending · {o.ticket_holders ?? 0} ticket holder(s)</div>
        {(['paystack', 'wallet', 'free'] as const).map((m) => pay[m] ? (
          <div key={m} style={{ fontSize: 13 }} data-testid={`cancellation-pay-${m}`}>
            {m === 'paystack' ? 'Card / bank (Paystack)' : m === 'wallet' ? 'VENTS Wallet' : 'Free tickets'}: {pay[m].tickets} ticket(s){m !== 'free' ? ` · ${naira(pay[m].kobo)} to refund` : ' · no money'}
          </div>
        ) : null)}
        {d.checked_in > 0 && <div style={{ fontSize: 12, color: adminTheme.amber }}>{d.checked_in} ticket(s) were checked in: they are not refunded automatically.</div>}
        {o.pending_purchases > 0 && <div style={{ fontSize: 12, color: adminTheme.amber }} data-testid="cancellation-pending-purchases">{o.pending_purchases} purchase(s) are still awaiting payment. A payment that completes after approval is queued for a refund automatically.</div>}
      </div>

      {r.status === 'requested' && (
        <div style={card}>
          <h3 style={h}>Decision</h3>
          {!isSuperAdmin ? <div style={muted}>Only a Super Admin can approve or reject a cancellation.</div> : (
            <>
              <textarea aria-label="Decision note" placeholder="Note (required to reject; shown to the organizer)" value={note} onChange={(e) => setNote(e.target.value)}
                style={{ width: '100%', minHeight: 64, background: adminTheme.panelAlt, color: adminTheme.text, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: 10, boxSizing: 'border-box' }} />
              {confirming ? (
                <div style={{ display: 'grid', gap: 8 }} data-testid="cancellation-confirm">
                  <div style={{ fontSize: 13 }}>
                    {confirming === 'approve'
                      ? `Approve: ${d.event?.title} is taken off sale now and ${o.paid_tickets ?? 0} paid ticket(s) are queued for refunds. This cannot be undone.`
                      : 'Reject: the event stays on sale and nothing is refunded.'}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={btn()} disabled={busy} data-testid="cancellation-confirm-yes"
                      onClick={() => run(async () => {
                        const res = await adminDecideEventCancellation(id, confirming === 'approve', note);
                        return confirming === 'approve' ? `Approved. ${res.refunds_queued ?? 0} refund(s) queued.` : 'Rejected. The organizer has been told.';
                      })}>{confirming === 'approve' ? 'Yes, approve cancellation' : 'Yes, reject'}</button>
                    <button style={btn(true)} disabled={busy} onClick={() => setConfirming(null)}>Back</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={btn()} data-testid="cancellation-approve" onClick={() => setConfirming('approve')}>Approve cancellation</button>
                  <button style={btn(true)} data-testid="cancellation-reject" disabled={!note.trim()} title={!note.trim() ? 'Add a note to reject' : undefined} onClick={() => setConfirming('reject')}>Reject</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {canProcess && (
        <div style={card}>
          <h3 style={h}>Refunds</h3>
          <div style={muted}>Each run sends up to 10 queued tickets through the normal refund path (existing per-admin and Paystack rate limits apply). Card refunds complete when Paystack confirms them.</div>
          <div><button style={btn()} disabled={busy} data-testid="cancellation-process" onClick={() => run(async () => {
            const x = await processCancellationRefunds(id, 10);
            return x.claimed === 0 ? 'Nothing to process right now.' : `Processed ${x.claimed}: ${x.refunded} refunded, ${x.pending} awaiting Paystack, ${x.failed} failed.`;
          })}>{busy ? 'Working…' : 'Process refunds'}</button></div>
        </div>
      )}

      {msg && <div role="status" style={{ ...card, fontSize: 13 }} data-testid="cancellation-msg">{msg}</div>}
      {error && <div role="alert" style={{ ...card, color: adminTheme.red, fontSize: 13 }}>{error}</div>}

      <div style={card}>
        <h3 style={h}>Affected tickets</h3>
        {(d.attendees || []).length === 0 ? <div style={muted}>No paid tickets.</div> : (d.attendees || []).map((a: any) => (
          <div key={a.ticket_id} data-testid={`cancellation-ticket-${a.ticket_id}`} style={{ borderTop: `1px solid ${adminTheme.borderSoft}`, paddingTop: 8, fontSize: 12.5, display: 'grid', gap: 2 }}>
            <div>{a.holder_name || 'Ticket holder'} · {a.ticket_type} · {naira(a.amount_kobo)} · {a.payment_method || 'paystack'}</div>
            <div style={muted}>
              {a.refund_status ? REFUND_LABEL[a.refund_status] ?? a.refund_status : 'Not queued'} · ticket {a.payment_status}
              {a.unconfirmed ? ' · Paystack did not confirm the request: check it in Paystack before reverting' : ''}
              {a.checked_in ? ' · checked in' : ''}
              {a.last_error ? ` · ${a.last_error}` : ''}
              {a.attempts ? ` · attempt ${a.attempts}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
