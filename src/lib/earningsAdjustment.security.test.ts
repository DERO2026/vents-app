import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateEarningsAdjustment, earningsAdjustmentRpcArgs, requestEarningsAdjustment,
  describeEarningsAdjustment, EARNINGS_ADJUSTMENT_CAP_KOBO, type EarningsAdjustmentInput,
} from './earningsAdjustment';

// Migration 0206 (audited two-admin earnings adjustments). Real-database
// behaviour is verified by scripts/local-pg-test/run-earnings-adjustment-verification.sh;
// these tests cover the client helper, the approver's label, and the
// migration text.

const ROOT = join(__dirname, '..', '..');
const base: EarningsAdjustmentInput = {
  organizerId: '00000000-0000-0000-0000-0000000000aa',
  kind: 'ledger_only', direction: 'debit', amountKobo: 100000,
  reason: 'Reverses a ledger credit with no source', evidenceRef: 'G1 row 64e7e2e8',
};

describe('validateEarningsAdjustment (mirrors the server)', () => {
  it('accepts each valid kind', () => {
    expect(validateEarningsAdjustment(base)).toBeNull();
    expect(validateEarningsAdjustment({ ...base, kind: 'wallet_credit', direction: 'credit' })).toBeNull();
    expect(validateEarningsAdjustment({ ...base, kind: 'wallet_debit' })).toBeNull();
    expect(validateEarningsAdjustment({ ...base, kind: 'late_recorded_payout', withdrawalRequestId: 'w1', paidAt: '2026-07-10T11:05:00Z' })).toBeNull();
  });
  it('refuses a direction that contradicts the kind', () => {
    expect(validateEarningsAdjustment({ ...base, kind: 'wallet_credit', direction: 'debit' })).toMatch(/credit/);
    expect(validateEarningsAdjustment({ ...base, kind: 'wallet_debit', direction: 'credit' })).toMatch(/debit/);
    expect(validateEarningsAdjustment({ ...base, kind: 'late_recorded_payout', direction: 'credit', withdrawalRequestId: 'w', paidAt: '2026-07-10' })).toMatch(/debit/);
  });
  it('refuses zero, negative, fractional and over-cap amounts', () => {
    for (const amountKobo of [0, -1, 1.5, EARNINGS_ADJUSTMENT_CAP_KOBO + 1]) {
      expect(validateEarningsAdjustment({ ...base, amountKobo })).not.toBeNull();
    }
    expect(validateEarningsAdjustment({ ...base, amountKobo: EARNINGS_ADJUSTMENT_CAP_KOBO })).toBeNull();
  });
  it('requires a 20-character reason and an evidence reference', () => {
    expect(validateEarningsAdjustment({ ...base, reason: 'too short' })).toMatch(/20 characters/);
    expect(validateEarningsAdjustment({ ...base, evidenceRef: '  ' })).toMatch(/evidence/);
  });
  it('a late payout must name the request and the Paystack date; nothing else may name a request', () => {
    expect(validateEarningsAdjustment({ ...base, kind: 'late_recorded_payout', paidAt: '2026-07-10' })).toMatch(/withdrawal request/);
    expect(validateEarningsAdjustment({ ...base, kind: 'late_recorded_payout', withdrawalRequestId: 'w' })).toMatch(/date/);
    expect(validateEarningsAdjustment({ ...base, withdrawalRequestId: 'w' })).toMatch(/Only a late payout/);
  });
});

describe('requestEarningsAdjustment', () => {
  it('only files a request through the server helper (no direct wallet or ledger write)', async () => {
    const rpc = vi.fn(async () => ({ data: { id: 'req-1' }, error: null }));
    const out = await requestEarningsAdjustment({ rpc }, base);
    expect(out).toEqual({ ok: true, requestId: 'req-1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_request_earnings_adjustment', earningsAdjustmentRpcArgs(base));
  });
  it('an invalid request never reaches the server', async () => {
    const rpc = vi.fn();
    const out = await requestEarningsAdjustment({ rpc: rpc as any }, { ...base, amountKobo: 0 });
    expect(out.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a server refusal is reported, not swallowed', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'An admin cannot request an adjustment to their own wallet' } }));
    expect(await requestEarningsAdjustment({ rpc }, base)).toEqual({ ok: false, error: 'An admin cannot request an adjustment to their own wallet' });
  });
  it('the wallet snapshot is never supplied by the client (the server takes it)', () => {
    const args = earningsAdjustmentRpcArgs(base);
    expect(Object.keys(args).some((k) => k.includes('expected'))).toBe(false);
    expect(args.p_withdrawal_request_id).toBeNull();
  });
});

describe('the approver sees exactly what will happen', () => {
  it('names the kind, effect, amount, reason, evidence and reviewed balance', () => {
    const s = describeEarningsAdjustment('Sub', 'testerboy', {
      kind: 'wallet_debit', direction: 'debit', amount_kobo: 3235000, reason: 'Unsourced balance removed', evidence_ref: 'D2', expected_balance_kobo: 30080000,
    });
    expect(s).toContain('wallet_debit');
    expect(s).toContain('REMOVES from the available balance');
    expect(s).toContain('₦32,350.00');
    expect(s).toContain('Unsourced balance removed');
    expect(s).toContain('D2');
    expect(s).toContain('₦300,800.00');
  });
  it('flags an unknown kind as INVALID instead of guessing', () => {
    expect(describeEarningsAdjustment('Sub', 'x', { kind: 'bonus' })).toContain('INVALID ("bonus")');
  });
  it('Admin → Actions maps earnings_adjustment to that description', () => {
    const src = readFileSync(join(ROOT, 'src', 'app', 'components', 'AdminActionsTab.tsx'), 'utf8');
    expect(src).toMatch(/earnings_adjustment: describeEarningsAdjustment\(who, label, r\.payload\)/);
  });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('no client or API code can bypass the two-admin path', () => {
  it('nothing in src/ or api/ calls the executor, writes the adjustment table, or inserts adjustment ledger types', () => {
    const offenders = [...listFiles(join(ROOT, 'src')), ...listFiles(join(ROOT, 'api'))].filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /execute_earnings_adjustment|from\(['"]earnings_adjustments['"]\)|adjustment_credit|adjustment_debit/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});

describe('migration 0206 (text)', () => {
  const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '0206_earnings_adjustment.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');

  it('two distinct admins, neither the wallet owner, enforced by a table CHECK as well as the executor', () => {
    expect(code).toMatch(/CHECK \(requested_by <> approved_by AND requested_by <> organizer_id AND approved_by <> organizer_id\)/);
    expect(code).toMatch(/IF r\.target_id IN \(r\.requested_by, v_approver\) THEN/);
    expect(code).toMatch(/IF NOT public\.is_super_admin\(\) THEN RAISE EXCEPTION 'Super Admin access required'/);
  });
  it('refuses a wallet that changed since the request', () => {
    expect(code).toMatch(/FOR UPDATE;/);
    expect(code).toMatch(/The wallet changed since this adjustment was requested/);
  });
  it('is idempotent and append-only, and never back-dates', () => {
    expect(code).toMatch(/admin_request_id\s+uuid NOT NULL UNIQUE/);
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON public\.earnings_adjustments/);
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.organizer_transactions/);
    expect(code).not.toMatch(/INSERT INTO public\.organizer_transactions \([^)]*created_at/);
  });
  it('a debit can never go negative or touch pending/held money', () => {
    expect(code).toMatch(/IF w\.balance_kobo < v_amount THEN/);
    expect(code).not.toMatch(/pending_kobo\s*=\s*pending_kobo\s*-/);
    expect(code).not.toMatch(/on_hold_kobo\s*=\s*on_hold_kobo\s*-/);
  });
  it('only the requester helper is client-callable', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.execute_earnings_adjustment\(uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_request_earnings_adjustment\([^)]*\) TO authenticated;/);
  });
  it('has a confirmed undo that refuses once anything was executed', () => {
    const undo = readFileSync(join(ROOT, 'supabase', 'rollback', 'undo_0206.sql'), 'utf8');
    expect(undo).toMatch(/IS DISTINCT FROM 'undo-0206'/);
    expect(undo).toMatch(/earnings adjustments have been executed/);
  });
});
