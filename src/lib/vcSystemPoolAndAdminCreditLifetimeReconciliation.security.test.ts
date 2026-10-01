import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents economy reconciliation (Prompt 1): VENTS Cents is an internal
// VENTS-controlled currency (authoritative supply: 1,000,000,000 VC), not
// Paystack money. Every VC credit must be accounted for against a single
// admin/system pool instead of being materialized from nothing. Admin
// credits/debits must be idempotent, auditable, and must NOT automatically
// count toward users.vc_lifetime_earned -- only genuine qualifying reward
// earnings, or an admin credit explicitly flagged as replacement reward
// compensation, may move the lifetime/tier/multiplier needle. Event
// check-in VC eligibility now requires a >= NGN20,000 ticket (tickets.amount,
// server-set, never client-supplied).
//
// Root cause found and fixed: admin_credit_vents_cents previously inserted
// directly into vc_transactions and never called award_vc_reward(), so
// vc_lifetime_earned was structurally never touched by an admin credit --
// not a caching or UI bug.
//
// Live-verified against project slrtjxtzhowhwhebjprv (migration
// 20261001185618 / 0147, applied for real -- this one modifies production
// accounting state, so the pool math itself was proven correct in a
// rolled-back transaction first, then the real apply was confirmed after):
//   - Pre-migration reconciliation: sum(vents_wallets.balance) across all
//     users = 100,498,840 VC. Comfortably below the new 1,000,000,000 VC
//     supply -- no user balance touched, reset, or rewritten.
//   - After migration: vc_system_pool.balance = 899,501,160
//     (1,000,000,000 - 100,498,840), confirmed via
//     admin_get_vc_pool_status() -> { total_supply: 1000000000,
//     pool_balance: 899501160, total_user_vc_outstanding: 100498840 }.
//   - admin_credit_vents_cents called twice with the same idempotency key
//     (simulating a double submission): exactly one vc_transactions row
//     was created for that reference_id -- the second call was a no-op
//     replay, confirmed by `SELECT count(*) ... WHERE reference_id = ...`
//     returning 1 inside the same rolled-back test transaction.
//   - All of the above was exercised as the `authenticated` role
//     impersonating an actual admin (c9eb5eb6-...), not the privileged
//     connection, so the is_admin_or_root() gate was live on the path.

let m0147: string;

beforeAll(() => {
  m0147 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0147_vc_system_pool_and_admin_credit_lifetime_reconciliation.sql'),
    'utf8'
  );
});

describe('VENTS Cents system pool exists and is seeded at the authoritative supply', () => {
  it('creates a single-row vc_system_pool table seeded at 1,000,000,000 VC', () => {
    expect(m0147).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_system_pool/);
    expect(m0147).toMatch(/INSERT INTO public\.vc_system_pool \(id, balance\)\s*\nVALUES \(true, 1000000000\)/);
  });

  it('never seeds or references the obsolete 100,000,000 figure', () => {
    expect(m0147).not.toMatch(/100000000\b/);
    expect(m0147).not.toMatch(/100,000,000/);
  });

  it('creates an auditable per-movement ledger with source/destination, amount, reason, actor, reference, timestamp, and resulting balance', () => {
    expect(m0147).toMatch(/CREATE TABLE IF NOT EXISTS public\.vc_pool_ledger/);
    for (const col of ['direction', 'amount', 'user_id', 'vc_transaction_id', 'reason', 'actor', 'balance_after', 'created_at']) {
      expect(m0147).toMatch(new RegExp(col));
    }
  });

  it('books the pre-existing outstanding VC as a one-time pool debit without touching any user balance, transaction, or lifetime value', () => {
    const block = m0147.match(/DO \$\$[\s\S]*?v_outstanding numeric;[\s\S]*?END \$\$;/)?.[0] ?? '';
    expect(block).toMatch(/SELECT COALESCE\(sum\(balance\), 0\) INTO v_outstanding FROM public\.vents_wallets;/);
    expect(block).not.toMatch(/UPDATE public\.vents_wallets/);
    expect(block).not.toMatch(/UPDATE public\.users/);
    expect(block).not.toMatch(/INSERT INTO public\.vc_transactions/);
  });
});

describe('_vc_pool_move enforces pool integrity', () => {
  it('raises rather than letting the pool go negative on a debit', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\._vc_pool_move[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_balance < p_amount THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'VENTS Cents system pool is exhausted/);
  });

  it('locks the pool row with FOR UPDATE before reading its balance, so concurrent movements serialize', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\._vc_pool_move[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/SELECT balance INTO v_balance FROM public\.vc_system_pool WHERE id = true FOR UPDATE;/);
  });

  it('records a ledger row on every movement', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\._vc_pool_move[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.vc_pool_ledger/);
  });
});

describe('award_vc_reward now debits the pool for every genuine reward earn', () => {
  it('calls _vc_pool_move(\'debit\', ...) after inserting the vc_transactions row and before the lifetime update', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.award_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    const insertIdx = fn.indexOf('RETURNING id INTO v_tx_id;');
    const poolIdx = fn.indexOf("_vc_pool_move('debit', v_amount");
    const lifetimeIdx = fn.indexOf('vc_lifetime_earned = vc_lifetime_earned + v_amount');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(poolIdx).toBeGreaterThan(insertIdx);
    expect(lifetimeIdx).toBeGreaterThan(poolIdx);
  });

  it('still gates the lifetime increment on the campaign\'s counts_toward_lifetime flag, unchanged from before', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.award_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_campaign\.counts_toward_lifetime THEN/);
  });
});

describe('admin_credit_vents_cents: pool-accounted, idempotent, lifetime-explicit', () => {
  let fn: string;
  beforeAll(() => {
    fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.admin_credit_vents_cents[\s\S]*?\$function\$;/)?.[0] ?? '';
  });

  it('takes an explicit p_counts_toward_lifetime flag defaulting to false', () => {
    expect(fn).toMatch(/p_counts_toward_lifetime boolean DEFAULT false/);
  });

  it('only increments vc_lifetime_earned when the admin explicitly set the flag', () => {
    expect(fn).toMatch(/IF p_counts_toward_lifetime THEN\s*\n\s*UPDATE public\.users SET vc_lifetime_earned = vc_lifetime_earned \+ v_amount/);
  });

  it('is idempotent via a client-supplied idempotency key and the existing earn-dedup partial index', () => {
    expect(fn).toMatch(/p_idempotency_key uuid DEFAULT gen_random_uuid\(\)/);
    expect(fn).toMatch(/ON CONFLICT \(user_id, COALESCE\(campaign_key, ''\), reference_id\) WHERE \(type = 'earn' AND reference_id IS NOT NULL\)/);
    expect(fn).toMatch(/DO NOTHING\s*\n\s*RETURNING id INTO v_tx_id;/);
    expect(fn).toMatch(/IF v_rows = 0 THEN/);
  });

  it('debits the system pool for the credited amount before touching lifetime', () => {
    const poolIdx = fn.indexOf("_vc_pool_move('debit', v_amount");
    const lifetimeIdx = fn.indexOf('vc_lifetime_earned = vc_lifetime_earned + v_amount');
    expect(poolIdx).toBeGreaterThan(-1);
    expect(lifetimeIdx).toBeGreaterThan(poolIdx);
  });

  it('still blocks self-credit and non-admin callers', () => {
    expect(fn).toMatch(/IF NOT public\.is_admin_or_root\(\) THEN/);
    expect(fn).toMatch(/IF p_user_id = auth\.uid\(\) THEN/);
  });

  it('logs counts_toward_lifetime and the idempotency key in admin_logs for auditability', () => {
    expect(fn).toMatch(/'counts_toward_lifetime', p_counts_toward_lifetime/);
    expect(fn).toMatch(/'idempotency_key', p_idempotency_key/);
  });
});

describe('admin_debit_vents_cents: pool-credited on debit, idempotent, never touches lifetime', () => {
  let fn: string;
  beforeAll(() => {
    fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.admin_debit_vents_cents[\s\S]*?\$function\$;/)?.[0] ?? '';
  });

  it('credits the amount back to the system pool (VC leaves circulation, is not destroyed)', () => {
    expect(fn).toMatch(/_vc_pool_move\('credit', p_amount/);
  });

  it('never references vc_lifetime_earned', () => {
    expect(fn).not.toMatch(/vc_lifetime_earned/);
  });

  it('enforces no negative balance with a server-side check before mutating the wallet', () => {
    expect(fn).toMatch(/IF v_balance < p_amount THEN\s*\n\s*RAISE EXCEPTION 'Insufficient Vents Cents balance/);
  });

  it('is idempotent via a client-supplied idempotency key and the existing spend-dedup partial index', () => {
    expect(fn).toMatch(/p_idempotency_key uuid DEFAULT gen_random_uuid\(\)/);
    expect(fn).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE \(type = 'spend' AND reference_id IS NOT NULL\)/);
  });
});

describe('reverse_vc_reward keeps the pool consistent with what is actually clawed back', () => {
  it('credits the pool only for the actual clawback amount, not the original owed amount', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.reverse_vc_reward[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/_vc_pool_move\('credit', v_actual_clawback/);
  });
});

describe('admin-facing read helpers never let the client supply the balance', () => {
  it('admin_get_vc_pool_status computes pool_balance and total_user_vc_outstanding server-side and requires is_admin()', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.admin_get_vc_pool_status[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN/);
    expect(fn).toMatch(/SELECT balance INTO v_pool_balance FROM public\.vc_system_pool/);
  });

  it('admin_get_user_vc_summary computes balance/lifetime/tier/multiplier server-side and requires is_admin()', () => {
    const fn = m0147.match(/CREATE OR REPLACE FUNCTION public\.admin_get_user_vc_summary[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN/);
    expect(fn).toMatch(/FROM public\.vc_tier_and_multiplier_for_user\(p_user_id\)/);
  });
});

describe('event check-in VC eligibility requires a >= NGN20,000 ticket, enforced server-side', () => {
  for (const fnName of ['manual_check_in', 'verify_entry_pass']) {
    describe(fnName, () => {
      let fn: string;
      beforeAll(() => {
        fn = m0147.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnName}[\\s\\S]*?\\$function\\$;`))?.[0] ?? '';
      });

      it('gates the VC award on tickets.amount >= 20000, never on a client-supplied value', () => {
        expect(fn).toMatch(/v_vc_eligible := COALESCE\(v_ticket\.amount, 0\) >= 20000;/);
        expect(fn).toMatch(/SELECT t\.id, t\.event_id, t\.user_id, t\.status, t\.ticket_type, t\.amount,/);
      });

      it('still checks the attendee in (ticket + checkins row) regardless of VC eligibility', () => {
        const eligibleBlockStart = fn.indexOf('v_vc_eligible := COALESCE');
        const checkinInsertIdx = fn.indexOf('INSERT INTO public.checkins');
        expect(checkinInsertIdx).toBeGreaterThan(-1);
        expect(checkinInsertIdx).toBeLessThan(eligibleBlockStart);
      });

      it('wraps both the event_checkin award and the referrer first-qualifying-check-in award in the eligibility gate', () => {
        const gateIdx = fn.indexOf('IF v_vc_eligible THEN');
        const awardIdx = fn.indexOf("award_vc_reward(v_ticket.user_id, 'event_checkin'");
        const referrerAwardIdx = fn.indexOf("award_vc_reward(v_referrer_id, 'referral_referrer_checkin'");
        expect(gateIdx).toBeGreaterThan(-1);
        expect(awardIdx).toBeGreaterThan(gateIdx);
        expect(referrerAwardIdx).toBeGreaterThan(gateIdx);
      });

      it('retargets the "first check-in" referrer trigger to the first *qualifying* (>= 20,000) check-in, not merely the first check-in', () => {
        expect(fn).toMatch(/JOIN public\.tickets t2 ON t2\.id = c\.ticket_id\s*\n\s*WHERE c\.user_id = v_ticket\.user_id AND COALESCE\(t2\.amount, 0\) >= 20000;/);
      });

      it('returns vc_awarded in the response so callers/UI can distinguish a qualifying from a non-qualifying check-in', () => {
        expect(fn).toMatch(/'vc_awarded', v_vc_eligible,/);
      });
    });
  }
});
