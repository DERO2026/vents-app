// Admin → Payouts → "Request earnings adjustment" (migration 0206).
//
// Files a request only. Nothing moves until a DIFFERENT super admin approves
// it in Admin → Actions, and the server then re-checks both admins, that
// neither owns the wallet, that the wallet is unchanged since this request
// (the server snapshots it now), the ₦50,000 cap and the evidence.
import React, { useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import {
  requestEarningsAdjustment, validateEarningsAdjustment,
  type EarningsAdjustmentKind, type EarningsAdjustmentInput,
} from '../../../lib/earningsAdjustment';

const KIND_LABEL: Record<EarningsAdjustmentKind, string> = {
  ledger_only: 'Ledger entry only (no wallet change)',
  wallet_credit: 'Wallet credit (adds to available balance)',
  wallet_debit: 'Wallet debit (removes from available balance)',
  late_recorded_payout: 'Record a payout Paystack already made',
};

const input: React.CSSProperties = {
  background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 8,
  padding: '6px 8px', color: adminTheme.text, fontSize: 12,
};

function Chip({ label, selected, onSelect, testId }: { label: string; selected: boolean; onSelect: () => void; testId: string }) {
  return (
    <button type="button" role="radio" aria-checked={selected} data-testid={testId} onClick={onSelect}
      style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
               border: `1px solid ${selected ? 'rgba(96,165,250,.5)' : adminTheme.border}`,
               background: selected ? 'rgba(96,165,250,.15)' : adminTheme.panel,
               color: selected ? adminTheme.blue : adminTheme.textMuted }}>
      {label}
    </button>
  );
}

export function EarningsAdjustmentForm() {
  const [organizerId, setOrganizerId] = useState('');
  const [kind, setKind] = useState<EarningsAdjustmentKind>('ledger_only');
  const [direction, setDirection] = useState<'credit' | 'debit'>('debit');
  const [naira, setNaira] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [withdrawalRequestId, setWithdrawalRequestId] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const effectiveDirection = kind === 'wallet_credit' ? 'credit' : kind === 'ledger_only' ? direction : 'debit';
  const build = (): EarningsAdjustmentInput => ({
    organizerId: organizerId.trim(), kind, direction: effectiveDirection,
    amountKobo: Math.round(Number(naira) * 100),
    reason, evidenceRef,
    withdrawalRequestId: kind === 'late_recorded_payout' ? withdrawalRequestId.trim() : undefined,
    // datetime-local is the admin's local time; send an unambiguous UTC instant.
    paidAt: kind === 'late_recorded_payout' && paidAt && !Number.isNaN(Date.parse(paidAt)) ? new Date(paidAt).toISOString() : undefined,
  });

  const submit = async () => {
    if (busy) return;
    const req = build();
    const invalid = validateEarningsAdjustment(req);
    if (invalid) { setResult({ ok: false, text: invalid }); return; }
    setBusy(true);
    setResult(null);
    try {
      const out = await requestEarningsAdjustment(supabase as any, req);
      if (out.ok === true) {
        setResult({ ok: true, text: `Request filed (${out.requestId.slice(0, 8)}). A different super admin must approve it in Admin → Actions. Nothing has moved yet.` });
      } else {
        setResult({ ok: false, text: out.error });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="earnings-adjustment-form" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: adminTheme.text }}>Request an earnings adjustment</p>
      <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>
        Two admins: you file it, a different super admin approves it. Neither may own the wallet. The wallet is snapshotted now; if it changes before approval the request is refused. Maximum ₦50,000. History is append-only.
      </p>
      <input aria-label="Organizer user id" placeholder="Organizer user id" value={organizerId} onChange={(e) => setOrganizerId(e.target.value)} style={input} />
      <div role="radiogroup" aria-label="Kind" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(Object.keys(KIND_LABEL) as EarningsAdjustmentKind[]).map((k) => (
          <Chip key={k} label={KIND_LABEL[k]} testId={`earnings-adjustment-kind-${k}`} selected={kind === k} onSelect={() => setKind(k)} />
        ))}
      </div>
      {kind === 'ledger_only' && (
        <div role="radiogroup" aria-label="Direction" style={{ display: 'flex', gap: 6 }}>
          <Chip label="Debit (ledger)" testId="earnings-adjustment-direction-debit" selected={direction === 'debit'} onSelect={() => setDirection('debit')} />
          <Chip label="Credit (ledger)" testId="earnings-adjustment-direction-credit" selected={direction === 'credit'} onSelect={() => setDirection('credit')} />
        </div>
      )}
      <input aria-label="Amount (₦)" placeholder="Amount (₦)" inputMode="decimal" value={naira} onChange={(e) => setNaira(e.target.value)} style={input} />
      {kind === 'late_recorded_payout' && (
        <>
          <input aria-label="Withdrawal request id" placeholder="Withdrawal request id" value={withdrawalRequestId} onChange={(e) => setWithdrawalRequestId(e.target.value)} style={input} />
          <input aria-label="Paid at (from Paystack)" type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} style={input} />
        </>
      )}
      <textarea aria-label="Reason" placeholder="Reason (at least 20 characters)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={input} />
      <input aria-label="Evidence reference" placeholder="Evidence (Paystack transfer code, ledger row, document)" value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} style={input} />
      <button data-testid="earnings-adjustment-submit" onClick={submit} disabled={busy} style={{ alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(96,165,250,.3)', background: 'rgba(96,165,250,.1)', color: adminTheme.blue, fontWeight: 600, fontSize: 12, cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'Filing…' : 'File for second-admin approval'}
      </button>
      {result && <p data-testid="earnings-adjustment-result" role="status" style={{ margin: 0, fontSize: 12, color: result.ok ? adminTheme.green : adminTheme.red }}>{result.text}</p>}
    </div>
  );
}
