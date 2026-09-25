import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for the customer VENTS Wallet foundation
// (0065_user_wallets.sql). Deliberately verifies this stays a THIRD,
// separate system from organizer_wallets (earnings) and vents_wallets (VC
// points) -- see that migration's own header comment.

let m0065: string;
let m0068: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0065 = readFileSync(join(dir, '0065_user_wallets.sql'), 'utf8');
  // confirm_wallet_deposit is CREATE OR REPLACE'd again in 0068 (accepts
  // Paystack's fee-inflated overpayment, credits only the intended amount)
  // -- tests against its current, deployed behavior read m0068 instead.
  m0068 = readFileSync(join(dir, '0068_wallet_deposit_allow_overpayment.sql'), 'utf8');
});

describe('user_wallets: creation/access, own-row RLS, no negative balance', () => {
  it('is a genuinely separate table from organizer_wallets and vents_wallets', () => {
    expect(m0065).toMatch(/CREATE TABLE IF NOT EXISTS public\.user_wallets/);
    expect(m0065).not.toMatch(/ALTER TABLE public\.organizer_wallets/);
    expect(m0065).not.toMatch(/ALTER TABLE public\.vents_wallets/);
  });

  it('get_my_wallet lazily creates the caller\'s wallet row on first access, scoped to auth.uid()', () => {
    const fn = m0065.match(/CREATE OR REPLACE FUNCTION public\.get_my_wallet\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;/);
    expect(fn).toMatch(/INSERT INTO public\.user_wallets \(user_id\) VALUES \(v_uid\)\s*\n\s*ON CONFLICT \(user_id\) DO NOTHING;/);
    expect(fn).toMatch(/WHERE uw\.user_id = v_uid/);
  });

  it('has an own-row-only SELECT policy and no client write policy at all', () => {
    expect(m0065).toMatch(/CREATE POLICY user_wallets_own_read ON public\.user_wallets FOR SELECT TO authenticated\s*\n\s*USING \(user_id = \(SELECT auth\.uid\(\)\)\);/);
    expect(m0065).not.toMatch(/CREATE POLICY user_wallets_insert/);
    expect(m0065).not.toMatch(/CREATE POLICY user_wallets_update/);
    expect(m0065).not.toMatch(/CREATE POLICY user_wallets_delete/);
    // Table-level grant to authenticated is SELECT-only.
    expect(m0065).toMatch(/GRANT SELECT ON public\.user_wallets TO authenticated;/);
    expect(m0065).not.toMatch(/GRANT[^;]*INSERT[^;]*ON public\.user_wallets TO authenticated/);
  });

  it('has a database-level CHECK preventing a negative balance, independent of any application logic', () => {
    expect(m0065).toMatch(/CONSTRAINT user_wallets_balance_non_negative CHECK \(balance_kobo >= 0\)/);
  });

  it('user_wallet_transactions is own-row-read-only too, with no client write policy', () => {
    expect(m0065).toMatch(/CREATE POLICY user_wallet_transactions_own_read ON public\.user_wallet_transactions FOR SELECT TO authenticated/);
    expect(m0065).not.toMatch(/CREATE POLICY user_wallet_transactions_insert/);
    expect(m0065).toMatch(/GRANT SELECT ON public\.user_wallet_transactions TO authenticated;/);
    expect(m0065).not.toMatch(/GRANT[^;]*INSERT[^;]*ON public\.user_wallet_transactions TO authenticated/);
  });
});

describe('user_wallet_transactions: ledger designed for deposit -> spend -> refund from day one', () => {
  it('the type CHECK constraint allows exactly deposit, spend, and refund', () => {
    expect(m0065).toMatch(/CONSTRAINT user_wallet_transactions_type_check CHECK \(type = ANY \(ARRAY\['deposit'::text, 'spend'::text, 'refund'::text\]\)\)/);
  });

  it('every ledger row records a positive magnitude, never a signed delta', () => {
    expect(m0065).toMatch(/CONSTRAINT user_wallet_transactions_amount_positive CHECK \(amount_kobo > 0\)/);
  });
});

describe('Wallet deposit: idempotent, server-authoritative amount, dedicated non-colliding reference prefix', () => {
  it('initiate_wallet_deposit generates a wdep_-prefixed reference, distinct from txf_ and BKG-', () => {
    const fn = m0065.match(/CREATE OR REPLACE FUNCTION public\.initiate_wallet_deposit[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/v_ref := 'wdep_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\);/);
  });

  it('confirm_wallet_deposit is project_admin-only, never reachable from the public Supabase client', () => {
    expect(m0065).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_wallet_deposit\(text, bigint\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.confirm_wallet_deposit\(text, bigint\) TO project_admin;/);
  });

  it('initiate_wallet_deposit locks in the intended amount server-side for this specific reference', () => {
    const fn = m0065.match(/CREATE OR REPLACE FUNCTION public\.initiate_wallet_deposit[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.wallet_deposit_attempts \(reference, user_id, amount_kobo\) VALUES \(v_ref, v_uid, p_amount_kobo\);/);
  });

  it('confirm_wallet_deposit rejects genuine underpayment against the server-recorded amount (defense-in-depth, not just caller trust)', () => {
    const fn = m0068.match(/CREATE OR REPLACE FUNCTION public\.confirm_wallet_deposit[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/IF p_amount_kobo < v_attempt\.amount_kobo THEN\s*\n\s*RETURN 'amount_mismatch:' \|\| v_attempt\.amount_kobo::text \|\| ':' \|\| p_amount_kobo::text;\s*\n\s*END IF;/);
    // The mismatch check runs BEFORE the ledger insert/credit -- a
    // fabricated (too-low) amount is rejected before any money-moving
    // statement runs.
    const mismatchIdx = fn.indexOf('amount_mismatch');
    const insertIdx = fn.indexOf('INSERT INTO public.user_wallet_transactions');
    expect(mismatchIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(mismatchIdx);
  });

  it('accepts Paystack overpayment (its own fee passed to the customer) but credits only the intended deposit amount, never the inflated verified amount', () => {
    const fn = m0068.match(/CREATE OR REPLACE FUNCTION public\.confirm_wallet_deposit[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/VALUES \(v_attempt\.user_id, 'deposit', v_attempt\.amount_kobo,/);
    expect(fn).toMatch(/VALUES \(v_attempt\.user_id, v_attempt\.amount_kobo\)/);
    expect(fn).not.toMatch(/VALUES \(v_attempt\.user_id, 'deposit', p_amount_kobo,/);
    expect(fn).not.toMatch(/VALUES \(v_attempt\.user_id, p_amount_kobo\)/);
  });

  it('wallet_deposit_attempts.amount_kobo is itself constrained positive at the database level', () => {
    expect(m0065).toMatch(/CONSTRAINT wallet_deposit_attempts_amount_positive CHECK \(amount_kobo > 0\)/);
  });

  it('is idempotent via a unique partial index on reference_id for deposits, guarding the actual credit with ON CONFLICT DO NOTHING', () => {
    expect(m0065).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_deposit_ref_idx\s*\n\s*ON public\.user_wallet_transactions \(reference_id\)\s*\n\s*WHERE \(type = 'deposit' AND reference_id IS NOT NULL\);/);
    const fn = m0065.match(/CREATE OR REPLACE FUNCTION public\.confirm_wallet_deposit[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'deposit' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(fn).toMatch(/IF v_tx_id IS NULL THEN\s*\n\s*RETURN 'already_credited';/);
  });

  it('wallet_deposit_attempts has zero client-facing access -- RLS enabled with no policy, no grant to anon/authenticated', () => {
    expect(m0065).toMatch(/ALTER TABLE public\.wallet_deposit_attempts ENABLE ROW LEVEL SECURITY;/);
    expect(m0065).not.toMatch(/CREATE POLICY[^;]*ON public\.wallet_deposit_attempts/);
    expect(m0065).not.toMatch(/GRANT[^;]*ON public\.wallet_deposit_attempts TO (anon|authenticated)/);
  });
});

describe('No withdrawal path exists for user_wallets, anywhere in this migration', () => {
  it('no function in this file ever debits/moves user_wallets balance out to a bank account or transfer', () => {
    // "withdraw"/"withdrawable" appear only in this migration's own prose
    // comments explaining that no such path exists -- what actually matters
    // is that no function NAME implies one, and no function ever decrements
    // user_wallets.balance_kobo (this pass creates zero functions that debit
    // it at all -- only get_my_wallet's initial INSERT and confirm_wallet_
    // deposit's credit-only UPDATE ever touch the column).
    expect(m0065).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.\w*withdraw\w*/i);
    expect(m0065).not.toMatch(/balance_kobo = public\.user_wallets\.balance_kobo -/);
    expect(m0065).not.toMatch(/paystack\.co\/transfer/);
  });
});
