// Client side of migration 0207 (audited two-admin withdrawal bank-account
// reassignment). The browser only FILES a request through
// admin_request_withdrawal_bank_reassignment, which validates and snapshots
// server-side. A different super admin approves it in Admin → Actions, and
// the server re-checks everything before the destination changes. Amount,
// reference, wallet and ledger are never touched; afterwards the withdrawal
// still needs the normal two-admin authorization (which binds the new
// recipient) before it can be paid.

export interface BankAccountOption {
  id: string;
  bank_name: string | null;
  account_number: string | null;
  is_active: boolean | null;
  recipient_code: string | null;
}

/** Last four digits only: the picker and the approver never need the full number. */
export function maskAccountNumber(n: string | null | undefined): string {
  if (!n) return '';
  return '****' + n.slice(-4);
}

/** Only accounts the server will accept: active and with a verified Paystack recipient. */
export function eligibleAccounts(accounts: BankAccountOption[], currentBankAccountId?: string | null): BankAccountOption[] {
  return accounts.filter((a) => a.is_active === true && !!a.recipient_code && a.id !== currentBankAccountId);
}

export function validateReassignment(withdrawalRequestId: string, newBankAccountId: string, reason: string): string | null {
  if (!withdrawalRequestId) return 'Choose the withdrawal to move.';
  if (!newBankAccountId) return 'Choose the organizer’s active, verified bank account.';
  if ((reason || '').trim().length < 20) return 'Give a reason of at least 20 characters.';
  return null;
}

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

export async function requestWithdrawalReassignment(
  client: RpcClient, withdrawalRequestId: string, newBankAccountId: string, reason: string,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const invalid = validateReassignment(withdrawalRequestId, newBankAccountId, reason);
  if (invalid) return { ok: false, error: invalid };
  const { data, error } = await client.rpc('admin_request_withdrawal_bank_reassignment', {
    p_withdrawal_request_id: withdrawalRequestId,
    p_new_bank_account_id: newBankAccountId,
    p_reason: reason.trim(),
  });
  if (error) return { ok: false, error: error.message };
  const id = (data as { id?: string } | null)?.id;
  return id ? { ok: true, requestId: id } : { ok: false, error: 'The server did not return a request id.' };
}

const naira = (kobo: unknown) =>
  typeof kobo === 'number' ? '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 }) : '?';

/** What the approving admin sees in Admin → Actions. Masked account numbers only. */
export function describeWithdrawalReassignment(who: string, label: string, payload: Record<string, unknown> | null | undefined): string {
  const p = payload || {};
  return `${who} requested to MOVE a withdrawal of ${naira(p.amount_kobo)} (${label}) `
    + `from ${String(p.old_account_masked || 'no account')} to ${String(p.new_account_masked || '?')}. `
    + `Amount, reference, wallet and ledger do not change; it still needs two-admin authorization before payment. `
    + `Reason: ${String(p.reason ?? '—')}. Refused if the withdrawal or the new account has changed since.`;
}
