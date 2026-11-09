// Admin → Payouts → pending withdrawal → "Move to another bank account"
// (migration 0207). Files a request only; a different super admin approves
// it in Admin → Actions. Lists only the organizer's active, verified
// accounts, with masked numbers.
import React, { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import {
  eligibleAccounts, maskAccountNumber, requestWithdrawalReassignment, validateReassignment,
  type BankAccountOption,
} from '../../../lib/withdrawalReassignment';

export function WithdrawalReassignForm({ requestId, organizerId }: { requestId: string; organizerId: string }) {
  const [accounts, setAccounts] = useState<BankAccountOption[] | null>(null);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('organizer_bank_accounts')
        .select('id, bank_name, account_number, is_active, recipient_code')
        .eq('organizer_id', organizerId);
      if (cancelled) return;
      setAccounts(error ? [] : eligibleAccounts((data as BankAccountOption[]) || []));
    })();
    return () => { cancelled = true; };
  }, [organizerId]);

  const submit = async () => {
    if (busy) return;
    const invalid = validateReassignment(requestId, choice, reason);
    if (invalid) { setResult({ ok: false, text: invalid }); return; }
    setBusy(true);
    setResult(null);
    try {
      const out = await requestWithdrawalReassignment(supabase as any, requestId, choice, reason);
      if (out.ok === true) {
        setResult({ ok: true, text: `Request filed (${out.requestId.slice(0, 8)}). A different super admin must approve it in Admin → Actions. The withdrawal has not moved yet.` });
      } else {
        setResult({ ok: false, text: out.error });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid={`withdrawal-reassign-${requestId}`} style={{ background: adminTheme.panelAlt, borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>
        Move this pending withdrawal to another of the organizer’s accounts. Two admins; neither may be the organizer. Amount, reference, wallet and ledger do not change, and it still needs two-admin authorization afterwards.
      </p>
      {accounts === null && <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>Loading accounts…</p>}
      {accounts !== null && accounts.length === 0 && (
        <p data-testid="withdrawal-reassign-none" style={{ margin: 0, fontSize: 12, color: adminTheme.amber }}>
          The organizer has no other active, verified bank account. They must add one first.
        </p>
      )}
      {accounts !== null && accounts.length > 0 && (
        <div role="radiogroup" aria-label="New bank account" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {accounts.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={choice === a.id} data-testid={`withdrawal-reassign-option-${a.id}`}
              onClick={() => setChoice(a.id)}
              style={{ padding: '5px 10px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                       border: `1px solid ${choice === a.id ? 'rgba(96,165,250,.5)' : adminTheme.border}`,
                       background: choice === a.id ? 'rgba(96,165,250,.15)' : adminTheme.panel,
                       color: choice === a.id ? adminTheme.blue : adminTheme.textMuted }}>
              {(a.bank_name || 'Bank') + ' ' + maskAccountNumber(a.account_number)}
            </button>
          ))}
        </div>
      )}
      <textarea aria-label="Reason" placeholder="Reason (at least 20 characters)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
        style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '6px 8px', color: adminTheme.text, fontSize: 12 }} />
      <button data-testid="withdrawal-reassign-submit" onClick={submit} disabled={busy || !accounts || accounts.length === 0}
        style={{ alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(96,165,250,.3)', background: 'rgba(96,165,250,.1)', color: adminTheme.blue, fontWeight: 600, fontSize: 12, cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'Filing…' : 'File for second-admin approval'}
      </button>
      {result && <p data-testid="withdrawal-reassign-result" role="status" style={{ margin: 0, fontSize: 12, color: result.ok ? adminTheme.green : adminTheme.red }}>{result.text}</p>}
    </div>
  );
}
