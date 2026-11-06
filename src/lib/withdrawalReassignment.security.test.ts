import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  maskAccountNumber, eligibleAccounts, validateReassignment, requestWithdrawalReassignment, describeWithdrawalReassignment,
} from './withdrawalReassignment';

// Migration 0207 (audited two-admin withdrawal bank-account reassignment,
// Batch D D4a). Real-database behaviour: scripts/local-pg-test/
// run-withdrawal-reassignment-verification.sh. These tests cover the client
// helper, the approver's label and the migration text.

const ROOT = join(__dirname, '..', '..');
const REASON = 'Organizer deactivated the old account; moving to their verified one';

describe('masking and eligibility', () => {
  it('shows only the last four digits', () => {
    expect(maskAccountNumber('2222222234')).toBe('****2234');
    expect(maskAccountNumber(null)).toBe('');
  });
  it('offers only active accounts with a verified Paystack recipient, never the current one', () => {
    const accounts = [
      { id: 'a', bank_name: 'A', account_number: '1', is_active: true, recipient_code: 'RCP_a' },
      { id: 'b', bank_name: 'B', account_number: '2', is_active: false, recipient_code: 'RCP_b' },
      { id: 'c', bank_name: 'C', account_number: '3', is_active: true, recipient_code: null },
      { id: 'd', bank_name: 'D', account_number: '4', is_active: true, recipient_code: 'RCP_d' },
    ];
    expect(eligibleAccounts(accounts, 'd').map((x) => x.id)).toEqual(['a']);
  });
});

describe('requestWithdrawalReassignment', () => {
  it('files through the server helper only', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 'req-1' }, error: null }));
    expect(await requestWithdrawalReassignment({ rpc }, 'w1', 'acct-2', REASON)).toEqual({ ok: true, requestId: 'req-1' });
    expect(rpc).toHaveBeenCalledWith('admin_request_withdrawal_bank_reassignment', {
      p_withdrawal_request_id: 'w1', p_new_bank_account_id: 'acct-2', p_reason: REASON,
    });
  });
  it('an invalid request never reaches the server', async () => {
    const rpc = vi.fn();
    expect(validateReassignment('w1', '', REASON)).toMatch(/bank account/);
    expect(validateReassignment('w1', 'a', 'short')).toMatch(/20 characters/);
    expect((await requestWithdrawalReassignment({ rpc: rpc as any }, 'w1', 'a', 'short')).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a server refusal is reported', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'The new bank account belongs to someone else' } }));
    expect(await requestWithdrawalReassignment({ rpc }, 'w1', 'x', REASON)).toEqual({ ok: false, error: 'The new bank account belongs to someone else' });
  });
});

describe('the approver sees what will happen, with masked numbers', () => {
  it('describes the move and what does not change', () => {
    const s = describeWithdrawalReassignment('Sub', 'withdrawal 1abe8e53', {
      amount_kobo: 2000000, old_account_masked: 'Old Bank ****1111', new_account_masked: 'New Bank ****2234', reason: REASON,
    });
    expect(s).toContain('₦20,000.00');
    expect(s).toContain('Old Bank ****1111');
    expect(s).toContain('New Bank ****2234');
    expect(s).toMatch(/Amount, reference, wallet and ledger do not change/);
    expect(s).toMatch(/two-admin authorization/);
  });
  it('Admin → Actions maps the action to that description', () => {
    const src = readFileSync(join(ROOT, 'src', 'app', 'components', 'AdminActionsTab.tsx'), 'utf8');
    expect(src).toMatch(/reassign_withdrawal_bank_account: describeWithdrawalReassignment\(who, label, r\.payload\)/);
  });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('no client or API code changes a withdrawal destination directly', () => {
  it('nothing in src/ or api/ calls the executor, writes the reassignment table, or updates bank_account_id on a withdrawal', () => {
    const offenders = [...listFiles(join(ROOT, 'src')), ...listFiles(join(ROOT, 'api'))].filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /execute_withdrawal_bank_reassignment|from\(['"]withdrawal_bank_reassignments['"]\)/.test(s)
        || /from\(['"]organizer_withdrawal_requests['"]\)\s*\.update\(/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

describe('migration 0207 (text)', () => {
  const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '0207_withdrawal_bank_reassignment.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');

  it('two distinct admins, neither the organizer (executor and table CHECK)', () => {
    expect(code).toMatch(/CHECK \(requested_by <> approved_by AND requested_by <> organizer_id AND approved_by <> organizer_id\)/);
    expect(code).toMatch(/IF w\.organizer_id IN \(r\.requested_by, v_approver\) THEN/);
  });
  it('only the organizer\'s own active, verified account; only a pending, unauthorized, never-sent withdrawal', () => {
    expect(code).toMatch(/IF b\.organizer_id <> w\.organizer_id THEN/);
    expect(code).toMatch(/IF NOT COALESCE\(b\.is_active, false\) THEN/);
    expect(code).toMatch(/b\.recipient_code IS NULL/);
    expect(code).toMatch(/IF w\.status <> 'pending' THEN/);
    expect(code).toMatch(/IF w\.approved_by IS NOT NULL THEN/);
    expect(code).toMatch(/IF w\.paystack_reference IS NOT NULL OR w\.transfer_code IS NOT NULL THEN/);
  });
  it('never touches amount, reference, wallet or ledger', () => {
    expect(code).not.toMatch(/amount_kobo\s*=/);
    expect(code).not.toMatch(/paystack_reference\s*=/);
    expect(code).not.toMatch(/(UPDATE|INSERT INTO)\s+public\.(organizer_wallets|organizer_transactions)\b/);
  });
  it('stores masked numbers only, and a destination guard blocks raw changes', () => {
    expect(code).toMatch(/'\*\*\*\*' \|\| right\(p, 4\)/);
    expect(code).toMatch(/BEFORE UPDATE ON public\.organizer_withdrawal_requests\s+FOR EACH ROW EXECUTE FUNCTION public\.organizer_withdrawal_destination_guard\(\)/);
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON public\.withdrawal_bank_reassignments/);
  });
  it('only the requester helper is client-callable; the undo refuses after use', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.execute_withdrawal_bank_reassignment\(uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_request_withdrawal_bank_reassignment\(uuid, uuid, text\) TO authenticated;/);
    const undo = readFileSync(join(ROOT, 'supabase', 'rollback', 'undo_0207.sql'), 'utf8');
    expect(undo).toMatch(/IS DISTINCT FROM 'undo-0207'/);
    expect(undo).toMatch(/withdrawals have been reassigned/);
  });
});
