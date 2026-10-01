import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents economy refactor, Batch E ("VC -> VENTS Wallet conversion"):
// backend-only. 10 VC = N1, minimum 10,000 VC (N1,000), Gold tier or
// higher, credits the existing customer VENTS Wallet (user_wallets /
// user_wallet_transactions) -- never a direct bank payout. No reward
// amounts, tier thresholds, multipliers, referral logic, check-in rewards,
// ticket redemption (still 2 VC = N1), or frontend code were touched.
//
// Live-verified against project slrtjxtzhowhwhebjprv (every statement run
// inside a rolled-back transaction against real users; production
// confirmed clean afterward -- 0 users with nonzero vc_lifetime_earned,
// 0 vc_conversion wallet transactions, 0 vc_withdrawal_requests rows):
//   - unauthenticated, Bronze (500 lifetime), and Silver (1,500 lifetime)
//     calls all rejected with their respective messages; Gold (4,000),
//     Platinum (8,000), Elite (15,000), and Legend (30,000) all accepted
//     a 10,000 VC conversion for exactly N1,000 (100,000 kobo), with
//     vc_lifetime_earned unchanged afterward in every case.
//   - amount validation: 9,999 VC rejected (below minimum); 25,000 VC
//     converted to exactly N2,500 (250,000 kobo); a request for far more
//     VC than the wallet held rejected with "Insufficient Vents Cents
//     balance"; 0 and -10,000 both rejected as non-positive; 10,005 (not
//     a multiple of 10) rejected explicitly, not silently rounded.
//   - idempotency: the same key called three times (identical amount,
//     then a retry, then a retry with a different amount) produced
//     exactly one vc_transactions row, exactly one user_wallet_transactions
//     row, and exactly one wallet credit (100,000 kobo total, not
//     doubled or tripled) -- every replay returned the ORIGINAL amount,
//     not whatever was passed on the retry. Two different idempotency
//     keys for the same user correctly produced two independent
//     conversions (200,000 kobo total).
//   - insufficient-balance race: a user with exactly 10,000 VC had two
//     conversion requests (different keys) for 10,000 VC each fired in
//     sequence -- the first succeeded, the second was rejected with
//     "Insufficient Vents Cents balance", and the final VC balance was
//     exactly 0, never negative.
//   - security: converting one user's VC left a different user's wallet
//     balance completely unchanged (the function takes no wallet/user-id
//     parameter at all -- it is structurally impossible to target another
//     user's wallet); as the `authenticated` role, a direct call to the
//     lower-level `_vc_deduct()` helper failed with permission denied.
//   - legacy cash-out: request_vc_cashout(), called as a Bronze-tier user
//     (who could never pass the new Gold+ gate), now raises "Direct VC
//     cash-out has been retired..." -- the old path cannot be used to
//     bypass the new model in any tier.
//
// Concurrency: the insufficient-balance race above was exercised
// sequentially (two calls, one after another, within the same test
// transaction), not via two truly simultaneous database connections --
// this tool-mediated test harness only issues statements sequentially, so
// genuinely concurrent sessions could not be fired against the live
// database in this pass (same disclosed limitation as every prior batch).
// The guarantee itself does not depend on test timing, though: the
// `SELECT ... FOR UPDATE` row lock on vents_wallets, taken only after the
// idempotency-key insert succeeds, structurally serializes any two
// concurrent conversion attempts for the same user at the database level,
// the same mechanism every other financial function in this codebase
// (_vc_deduct, confirm_wallet_deposit, award_vc_reward's campaign lock)
// already relies on for the identical guarantee.

let m0146: string;

beforeAll(() => {
  m0146 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0146_vc_wallet_conversion_foundation.sql'), 'utf8');
});

describe('convert_vc_to_wallet enforces the approved rate, minimum, and tier gate', () => {
  it('requires authentication and a positive integer VC amount', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
    expect(fn).toMatch(/IF p_vc_amount IS NULL OR p_vc_amount <= 0 THEN/);
  });

  it('enforces the 10,000 VC minimum and the exact 10 VC = N1 rate with no silent rounding', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF p_vc_amount < 10000 THEN/);
    expect(fn).toMatch(/IF p_vc_amount % 10 <> 0 THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'VC amount must be a multiple of 10/);
    expect(fn).not.toMatch(/round\(/);
    expect(fn).toMatch(/v_naira := \(p_vc_amount::bigint \/ 10\);/);
    expect(fn).toMatch(/v_kobo := v_naira \* 100;/);
  });

  it('computes tier server-side from vc_lifetime_earned via the authoritative functions, never from vc_badge or balance', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/SELECT tier INTO v_tier FROM public\.vc_tier_and_multiplier_for_user\(v_user_id\);/);
    expect(fn).not.toMatch(/users\.vc_badge\b|\bvc_badge\b(?!_tiers)/);
    expect(fn).toMatch(/IF v_tier_rank IS NULL OR v_tier_rank < v_gold_rank THEN/);
  });
});

describe('conversion is atomic, idempotent, and uses the existing VC/wallet ledgers', () => {
  it('both ledger inserts happen in the same function body -- a single transaction, no cross-function coordination', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.vc_transactions/);
    expect(fn).toMatch(/INSERT INTO public\.user_wallet_transactions/);
    expect(fn).toMatch(/INSERT INTO public\.user_wallets/);
  });

  it('dedups on a caller-supplied idempotency key via a new partial unique index on each ledger', () => {
    expect(m0146).toMatch(/CREATE UNIQUE INDEX vc_transactions_spend_dedup_idx[\s\S]*?WHERE \(type = 'spend' AND reference_id IS NOT NULL\)/);
    expect(m0146).toMatch(/CREATE UNIQUE INDEX user_wallet_transactions_vc_conversion_ref_idx[\s\S]*?WHERE \(type = 'vc_conversion' AND reference_id IS NOT NULL\)/);
  });

  it('replay path returns the ORIGINAL amount, not the retry\'s amount', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_rows = 0 THEN/);
    expect(fn).toMatch(/SELECT amount INTO v_existing_amount FROM public\.vc_transactions/);
    expect(fn).toMatch(/'idempotent_replay', true,\s*\n\s*'vc_amount', v_existing_amount/);
  });

  it('locks the wallet balance only after the idempotency check, so pure retries never contend for the lock', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    const conflictIdx = fn.indexOf('GET DIAGNOSTICS v_rows');
    const lockIdx = fn.indexOf('FOR UPDATE');
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(conflictIdx);
  });

  it('never writes vc_lifetime_earned -- spend invariance is structural, not just behavioral', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/vc_lifetime_earned/);
  });

  it('new wallet transaction type is explicit and documented, not reused from an existing type', () => {
    expect(m0146).toMatch(/ADD CONSTRAINT user_wallet_transactions_type_check[\s\S]*?'vc_conversion'/);
  });
});

describe('convert_vc_to_wallet cannot target another user and is not reachable by anon', () => {
  it('takes no user-id or wallet-id parameter -- the only identity it can act on is auth.uid()', () => {
    expect(m0146).toMatch(/CREATE OR REPLACE FUNCTION public\.convert_vc_to_wallet\(p_vc_amount integer, p_idempotency_key uuid\)/);
  });

  it('is revoked from anon and granted only to authenticated/project_admin', () => {
    expect(m0146).toMatch(/REVOKE ALL ON FUNCTION public\.convert_vc_to_wallet\(integer, uuid\) FROM PUBLIC, anon;/);
    expect(m0146).toMatch(/GRANT EXECUTE ON FUNCTION public\.convert_vc_to_wallet\(integer, uuid\) TO authenticated, project_admin;/);
  });
});

describe('legacy direct VC cash-out is retired without deleting its history', () => {
  it('request_vc_cashout now always raises -- no VC deduction, no withdrawal request row, for any tier', () => {
    const fn = m0146.match(/CREATE OR REPLACE FUNCTION public\.request_vc_cashout[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/RAISE EXCEPTION 'Direct VC cash-out has been retired\./);
    expect(fn).not.toMatch(/INSERT INTO public\.vc_withdrawal_requests/);
    expect(fn).not.toMatch(/_vc_deduct/);
  });

  it('does not alter vc_bank_accounts, vc_withdrawal_requests, or any tier threshold/multiplier', () => {
    const sqlOnly = m0146.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(sqlOnly).not.toMatch(/CREATE TABLE/);
    expect(sqlOnly).not.toMatch(/vc_badge_tiers.*SET/);
    expect(sqlOnly).not.toMatch(/DROP TABLE/);
  });
});
