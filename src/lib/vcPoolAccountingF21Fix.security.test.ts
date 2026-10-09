import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit finding F21 (MASTER_AUDIT.md): convert_vc_to_wallet() never credited
// the VC system pool when VC permanently left circulation via conversion to
// real wallet cash -- confirmed live against 7 production conversions
// (362,000 VC / NGN36,200) with zero matching vc_pool_ledger rows.
//
// Two drafted migrations, NEITHER applied to production yet:
//   - 0171_fix_vc_to_wallet_conversion_pool_accounting.sql: the forward fix.
//     Identical to the live function (0146) except one added
//     _vc_pool_move('credit', ...) call, placed so a replayed/idempotent
//     call can never reach it twice.
//   - 0172_backfill_vc_to_wallet_pool_ledger_historical.sql: a SEPARATE,
//     idempotent historical-reconciliation pair of functions (list + apply),
//     following this codebase's own established pattern from
//     0053_service_provider_capability_sync_invariant.sql. Does not touch
//     vents_wallets/user_wallets/user_wallet_transactions -- only the
//     pool's own ledger, which is what's actually out of sync.
//
// This suite is static-analysis only (same approach as every other
// *.security.test.ts in this repo) -- it verifies the drafted SQL text
// says what it's supposed to, not live database behavior (this harness has
// no live Postgres connection; see vcWalletConversion.security.test.ts's
// own disclosed limitation on concurrency testing for the same reason).

let m0171: string;
let m0172: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0171 = readFileSync(join(dir, '0171_fix_vc_to_wallet_conversion_pool_accounting.sql'), 'utf8');
  m0172 = readFileSync(join(dir, '0172_backfill_vc_to_wallet_pool_ledger_historical.sql'), 'utf8');
});

describe('0171: convert_vc_to_wallet forward fix credits the pool exactly once per conversion', () => {
  it('calls _vc_pool_move with direction credit, the converted amount, and the real vc_transaction_id', () => {
    expect(m0171).toMatch(
      /PERFORM public\._vc_pool_move\('credit', p_vc_amount, v_user_id, v_vc_tx_id, 'vc_to_wallet_conversion', v_user_id\);/
    );
  });

  it('places the pool-move call after the idempotency early-return, so a replay never reaches it twice', () => {
    const replayIdx = m0171.indexOf("'idempotent_replay', true");
    const poolMoveIdx = m0171.indexOf("PERFORM public._vc_pool_move(");
    expect(replayIdx).toBeGreaterThan(-1);
    expect(poolMoveIdx).toBeGreaterThan(replayIdx);
  });

  it('places the pool-move call after the wallet debit and before the wallet-credit ledger insert, preserving existing lock order', () => {
    const debitIdx = m0171.indexOf('UPDATE public.vents_wallets SET balance = balance - p_vc_amount');
    const poolMoveIdx = m0171.indexOf("PERFORM public._vc_pool_move(");
    const walletTxIdx = m0171.indexOf('INSERT INTO public.user_wallet_transactions');
    expect(debitIdx).toBeGreaterThan(-1);
    expect(poolMoveIdx).toBeGreaterThan(debitIdx);
    expect(walletTxIdx).toBeGreaterThan(poolMoveIdx);
  });

  it('preserves every validation and rate rule unchanged from the live function', () => {
    expect(m0171).toMatch(/IF p_vc_amount < 10000 THEN/);
    expect(m0171).toMatch(/IF p_vc_amount % 10 <> 0 THEN/);
    expect(m0171).toMatch(/v_naira := \(p_vc_amount::bigint \/ 10\);/);
    expect(m0171).toMatch(/IF v_tier_rank IS NULL OR v_tier_rank < v_gold_rank THEN/);
  });

  it('still never writes vc_lifetime_earned -- the fix only touches pool accounting', () => {
    expect(m0171).not.toMatch(/vc_lifetime_earned/);
  });
});

describe('0172: historical pool-ledger backfill is scoped, idempotent, and leaves wallet balances untouched', () => {
  it('list function is read-only (STABLE) and ACTUALLY admin-gated by an internal check, not just by its grant', () => {
    // Self-correction caught during review: an earlier draft of this
    // function was LANGUAGE sql (no IF/RAISE possible) with no internal
    // check at all, copying a pre-existing gap now tracked separately as
    // F23 (list_service_provider_capability_desync, migration 0053, live
    // in production, confirmed callable by any `authenticated` user). This
    // test asserts the actual internal guard exists, not just the grant --
    // a bare GRANT-to-authenticated assertion would have passed against
    // that same flawed version and proven nothing.
    const fn = m0172.match(/CREATE OR REPLACE FUNCTION public\.list_vc_to_wallet_pool_backfill_candidates[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/STABLE SECURITY DEFINER/);
    expect(fn).toMatch(/LANGUAGE plpgsql/);
    expect(fn).toMatch(/IF NOT public\.is_admin\(\) THEN/);
    expect(m0172).toMatch(/GRANT EXECUTE ON FUNCTION public\.list_vc_to_wallet_pool_backfill_candidates\(\) TO authenticated, project_admin;/);
  });

  it('apply function requires is_root(), stricter than the Super-Admin gate used elsewhere', () => {
    const fn = m0172.match(/CREATE OR REPLACE FUNCTION public\.backfill_vc_to_wallet_pool_ledger[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF NOT public\.is_root\(\) THEN/);
  });

  it('is idempotent by construction -- only ever selects rows with no matching vc_pool_ledger entry yet', () => {
    const fn = m0172.match(/CREATE OR REPLACE FUNCTION public\.backfill_vc_to_wallet_pool_ledger[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.vc_pool_ledger pl WHERE pl\.vc_transaction_id = vt\.id\s*\n\s*\)/);
  });

  it('never touches vents_wallets, user_wallets, or user_wallet_transactions -- only the pool itself', () => {
    const fn = m0172.match(/CREATE OR REPLACE FUNCTION public\.backfill_vc_to_wallet_pool_ledger[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/vents_wallets|user_wallets|user_wallet_transactions/);
  });

  it('logs the backfill as one auditable batch action to admin_logs', () => {
    const fn = m0172.match(/CREATE OR REPLACE FUNCTION public\.backfill_vc_to_wallet_pool_ledger[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(fn).toMatch(/'vc_pool_ledger_historical_backfill'/);
  });

  it('both functions are revoked from anon/authenticated by default and granted back explicitly', () => {
    expect(m0172).toMatch(/REVOKE ALL ON FUNCTION public\.list_vc_to_wallet_pool_backfill_candidates\(\) FROM PUBLIC, anon, authenticated, project_admin;/);
    expect(m0172).toMatch(/REVOKE ALL ON FUNCTION public\.backfill_vc_to_wallet_pool_ledger\(\) FROM PUBLIC, anon, authenticated, project_admin;/);
  });
});
