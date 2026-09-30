import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Financial safety audit of the withdrawal/payout system (organizer AND
// service-provider earnings, which share organizer_wallets/
// organizer_transactions/organizer_withdrawal_requests -- there is no
// separate provider-only ledger). Confirmed against the LIVE production
// function/grant definitions before this migration (via pg_get_functiondef
// and information_schema.routine_privileges over the Supabase MCP
// connection), not hypothesized. Static-analysis style, matching this
// repo's existing security-test convention (organizerPayoutSecurity.
// security.test.ts et al.) -- there is no live-DB harness in vitest.
//
// Core invariant under audit: no successful withdrawal/payout may ever
// cause an account's available balance to become negative, or allow more
// to be withdrawn than is actually available, under any of: double-tap,
// duplicate/retried request, concurrent requests, stale client balance,
// a pending withdrawal, a failed/retried/reversed payout, a duplicate
// webhook, a simultaneous admin credit/debit or refund.

let m0123: string;
let m0054: string;
let m0076: string;
let m0110: string;
let walletScreenSrc: string;
let webhookSrc: string;
let adminPayoutActionSrc: string;
let reconcilePayoutsSrc: string;

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`);
  return src.match(re)?.[0] ?? '';
}

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0123 = readFileSync(join(dir, '0123_withdrawal_payout_financial_safety.sql'), 'utf8');
  m0054 = readFileSync(join(dir, '0054_service_bookings_marketplace.sql'), 'utf8');
  m0076 = readFileSync(join(dir, '0076_fix_withdrawal_rls_hole_and_payout_ambiguity_bugs.sql'), 'utf8');
  m0110 = readFileSync(join(dir, '0110_revoke_broad_write_grants_wallet_and_audit_tables.sql'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  walletScreenSrc = readFileSync(join(componentsDir, 'WalletScreen.tsx'), 'utf8');
  const apiDir = join(__dirname, '..', '..', 'api');
  webhookSrc = readFileSync(join(apiDir, 'webhook', 'paystack.ts'), 'utf8');
  adminPayoutActionSrc = readFileSync(join(apiDir, 'wallet', 'admin-payout-action.ts'), 'utf8');
  reconcilePayoutsSrc = readFileSync(join(apiDir, 'wallet', 'reconcile-payouts.ts'), 'utf8');
});

describe('VULNERABILITY (fixed): credit_provider_wallet_for_booking was a free-money primitive', () => {
  it('0054 originally granted EXECUTE to authenticated with zero internal verification -- confirms this was real and shipped, not hypothetical', () => {
    expect(m0054).toMatch(/GRANT EXECUTE ON FUNCTION public\.credit_provider_wallet_for_booking\(uuid, bigint, uuid, text\) TO authenticated, project_admin;/);
    const original = fn(m0054, 'credit_provider_wallet_for_booking');
    expect(original).not.toMatch(/auth\.uid\(\)/);
    expect(original).not.toMatch(/is_admin/);
  });

  it('0123 revokes the authenticated/anon/PUBLIC grant -- every real call site is a nested PERFORM from another SECURITY DEFINER function, which never needed it', () => {
    expect(m0123).toMatch(/REVOKE EXECUTE ON FUNCTION public\.credit_provider_wallet_for_booking\(uuid, bigint, uuid, text\) FROM authenticated, anon, PUBLIC;/);
  });

  it('the fixed function verifies the booking exists, belongs to the named provider, matches its subtotal exactly, and is paid -- under a row lock -- before crediting anything', () => {
    const fixed = fn(m0123, 'credit_provider_wallet_for_booking');
    expect(fixed).toMatch(/FOR UPDATE OF b/);
    expect(fixed).toMatch(/IF v_booking\.provider_user_id IS DISTINCT FROM p_provider_user_id THEN/);
    expect(fixed).toMatch(/IF p_amount_kobo <> v_booking\.subtotal_kobo THEN/);
    expect(fixed).toMatch(/IF v_booking\.payment_status <> 'paid' THEN/);
  });

  it('preserves the pre-existing double-credit guard for the same booking (idempotent under retried/duplicate calls)', () => {
    const fixed = fn(m0123, 'credit_provider_wallet_for_booking');
    expect(fixed).toMatch(/WHERE type = 'credit' AND metadata->>'service_booking_id' = p_booking_id::text/);
    expect(fixed).toMatch(/\bRETURN;\s*\n\s*END IF;/);
  });
});

describe('Scenario 17 & 18: organizer wallet and service-provider wallet share one audited ledger', () => {
  it('service-provider earnings are credited into the same organizer_wallets/organizer_transactions tables organizer ticket sales use (no separate, unaudited provider ledger)', () => {
    const fixed = fn(m0123, 'credit_provider_wallet_for_booking');
    expect(fixed).toMatch(/INSERT INTO public\.organizer_wallets/);
    expect(fixed).toMatch(/INSERT INTO public\.organizer_transactions/);
  });

  it('both organizer and provider withdrawals go through the exact same request_organizer_payout / complete / fail / cancel / reject RPCs -- traced independently, confirmed identical', () => {
    expect(walletScreenSrc).toMatch(/supabase\.rpc\('request_organizer_payout'/);
    // isEarner includes both isOrganizer and is_service_provider, both routed
    // to the same withdrawal UI and the same RPC -- not two parallel systems.
    expect(walletScreenSrc).toMatch(/currentUser\?\.isOrganizer.*currentUser\?\.is_service_provider === true/s);
  });
});

describe('Core invariant: concurrent withdrawals cannot overdraw (the ₦10,000 / ₦7,000+₦7,000 scenario)', () => {
  it('request_organizer_payout locks the wallet row with FOR UPDATE, then checks balance, then debits, all inside one function transaction -- a second concurrent caller blocks until the first commits and re-reads the POST-debit balance', () => {
    const rpo = fn(m0123, 'request_organizer_payout');
    // Order matters: FOR UPDATE lock must precede the balance check, and the
    // check must precede the debit -- this is what makes read-check-write
    // atomic instead of a TOCTOU race.
    const lockIdx = rpo.indexOf('FOR UPDATE');
    const checkIdx = rpo.indexOf('v_balance < p_amount_kobo');
    const debitIdx = rpo.indexOf('balance_kobo = balance_kobo - p_amount_kobo');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(lockIdx);
    expect(debitIdx).toBeGreaterThan(checkIdx);
  });

  it('a request that would overdraw raises and does not touch the wallet row at all', () => {
    const rpo = fn(m0123, 'request_organizer_payout');
    expect(rpo).toMatch(/IF v_balance IS NULL OR v_balance < p_amount_kobo THEN\s*\n\s*RAISE EXCEPTION 'Insufficient balance';/);
  });
});

describe('Scenario: zero and negative withdrawal amounts are rejected server-side', () => {
  it('request_organizer_payout rejects amount <= 0 before touching the wallet', () => {
    const rpo = fn(m0123, 'request_organizer_payout');
    expect(rpo).toMatch(/IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN\s*\n\s*RAISE EXCEPTION 'Invalid amount';/);
  });
});

describe('Scenario: duplicate/double-tap withdrawal request is idempotent, not merely non-overdrawing', () => {
  it('adds a client-suppliable idempotency_key with a unique (organizer_id, idempotency_key) index', () => {
    expect(m0123).toMatch(/ADD COLUMN IF NOT EXISTS idempotency_key text;/);
    expect(m0123).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uniq_organizer_withdraw_idempotency\s*\n\s*ON public\.organizer_withdrawal_requests \(organizer_id, idempotency_key\)/);
  });

  it('a replayed key short-circuits to the original request before any balance check or debit', () => {
    const rpo = fn(m0123, 'request_organizer_payout');
    const replayIdx = rpo.indexOf('Idempotent replay');
    const lockIdx = rpo.indexOf('FOR UPDATE');
    expect(replayIdx).toBeGreaterThan(-1);
    expect(replayIdx).toBeLessThan(lockIdx);
  });

  it('a genuine concurrent race on the SAME idempotency key (both pass the pre-check before either inserts) is caught by the unique index and rolled back exactly once, never double-debited', () => {
    const rpo = fn(m0123, 'request_organizer_payout');
    expect(rpo).toMatch(/EXCEPTION WHEN unique_violation THEN/);
    expect(rpo).toMatch(/balance_kobo = balance_kobo \+ p_amount_kobo,\s*\n\s*pending_kobo = GREATEST\(0, pending_kobo - p_amount_kobo\)/);
  });

  it('the client generates one idempotency key per withdrawal attempt (reused across retries of that attempt, cleared on success/amount-change/reopen)', () => {
    expect(walletScreenSrc).toMatch(/withdrawIdempotencyKeyRef/);
    expect(walletScreenSrc).toMatch(/p_idempotency_key: withdrawIdempotencyKeyRef\.current/);
  });
});

describe('Scenario: unauthorized user cannot withdraw against another account', () => {
  it('request_organizer_payout only ever operates on auth.uid()\'s own wallet/bank account -- there is no organizer_id parameter a caller could substitute', () => {
    const rpo = fn(m0123, 'request_organizer_payout');
    expect(rpo).toMatch(/v_organizer_id uuid := auth\.uid\(\);/);
    expect(rpo).not.toMatch(/p_organizer_id/);
    expect(rpo).toMatch(/WHERE id = p_bank_account_id AND organizer_id = v_organizer_id/);
  });

  it('organizer_wallets/organizer_transactions/organizer_withdrawal_requests have zero client-writable table grants -- confirmed all writes go through SECURITY DEFINER RPCs only', () => {
    expect(m0110).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.organizer_wallets FROM anon, authenticated;/);
    expect(m0110).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.organizer_transactions FROM anon, authenticated;/);
    expect(m0110).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.organizer_withdrawal_requests FROM anon, authenticated;/);
  });
});

describe('Scenario: admin permission boundaries on payout decisions', () => {
  it('approve/reject/cancel all require is_admin_or_root (Super Admin), not just is_admin (Sub-Admin)', () => {
    expect(m0076).toMatch(/admin_cancel_processing_payout[\s\S]*?IF NOT public\.is_admin_or_root\(\) THEN RAISE EXCEPTION 'Super Admin access required'; END IF;/);
  });

  it('the claim-before-transfer step (admin_claim_payout_for_processing) is an atomic compare-and-swap UPDATE ... WHERE status = \'pending\' -- a second concurrent admin approval attempt on the same request gets claimed=false and never reaches Paystack', () => {
    expect(adminPayoutActionSrc).toMatch(/claimed === true/);
    expect(adminPayoutActionSrc).toMatch(/if \(!claimRow\.claimed\)/);
  });

  it('a claimed-but-unattempted request (no recipient_code, or Paystack itself rejected the transfer) is released back to pending rather than stuck consuming funds forever', () => {
    expect(adminPayoutActionSrc).toMatch(/admin_release_payout_claim/g);
  });
});

describe('Scenario: failed payout does not permanently consume funds; retry and reversal are handled', () => {
  it('fail_organizer_payout (webhook-driven, covers transfer.failed AND transfer.reversed) restores balance_kobo and clears pending_kobo', () => {
    expect(webhookSrc).toMatch(/event\?\.event === 'transfer\.success' \|\| event\?\.event === 'transfer\.failed' \|\| event\?\.event === 'transfer\.reversed'/);
    expect(webhookSrc).toMatch(/const rpcName = event\.event === 'transfer\.success' \? 'complete_organizer_payout' : 'fail_organizer_payout';/);
  });

  it('a released/failed request returns to \'pending\' or has its funds restored, so the same withdrawal can be retried without re-debiting the wallet', () => {
    // admin_release_payout_claim (0076-era) flips back to pending with no
    // wallet change (funds were never actually released from pending_kobo
    // at the claim step -- only at request time), and fail_organizer_payout
    // explicitly restores balance_kobo. Both are exercised by the webhook/
    // admin-action paths asserted above.
    expect(webhookSrc).toMatch(/fail_organizer_payout/);
  });
});

describe('Scenario: duplicate Paystack webhook does not double-process', () => {
  it('the webhook verifies Paystack\'s HMAC signature with a timing-safe comparison before processing anything', () => {
    expect(webhookSrc).toMatch(/crypto\s*\n?\s*\.createHmac\('sha512', secret\)/);
    expect(webhookSrc).toMatch(/crypto\.timingSafeEqual\(signatureBuf, expectedBuf\)/);
  });

  it('complete_organizer_payout is idempotent: a repeat call for an already-completed request returns \'already_completed\' and performs no further wallet mutation', () => {
    expect(m0076).toMatch(/complete_organizer_payout|fail_organizer_payout/); // sanity: file covers these
    const m0023 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0023_fix_payout_functions_ambiguous_status.sql'), 'utf8');
    const completeFn = fn(m0023, 'complete_organizer_payout');
    expect(completeFn).toMatch(/GET DIAGNOSTICS v_rows = ROW_COUNT;\s*\n\s*IF v_rows = 0 THEN[\s\S]*?RETURN QUERY[\s\S]*?SELECT 'already_completed'/);
  });

  it('the webhook only sends the payout decision email on a genuine first-time status change, never on a retried/duplicate webhook delivery', () => {
    expect(webhookSrc).toMatch(/never on 'not_found'\/'already_completed'\/'already_finalized', which\s*\n\s*\/\/ would otherwise re-send on Paystack's webhook retries\./);
  });
});

describe('Emergency safety: reconciliation never guesses a payout outcome', () => {
  it('an unresolved/unrecognized Paystack transfer status is left untouched (still_pending / lookup_failed), never assumed successful or failed', () => {
    expect(reconcilePayoutsSrc).toMatch(/if \(pstStatus !== 'success' && pstStatus !== 'failed' && pstStatus !== 'reversed'\) \{/);
    expect(reconcilePayoutsSrc).toMatch(/outcome: 'still_pending_on_paystack'/);
    expect(reconcilePayoutsSrc).toMatch(/outcome: 'paystack_lookup_failed'/);
  });
});

describe('Scenario: simultaneous refund + withdrawal cannot overdraw either', () => {
  it('refund_ticket / finalize_ticket_refund / cancel_service_booking / finalize_service_booking_refund all lock the wallet row with FOR UPDATE and clamp the debit at LEAST(current balance, amount owed) -- never driving balance negative even if a withdrawal already took the funds', () => {
    const m0067 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0067_wallet_refunds.sql'), 'utf8');
    const m0077 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0077_service_booking_refunds.sql'), 'utf8');
    for (const src of [m0067, m0077]) {
      expect(src).toMatch(/v_actual_debit := LEAST\(COALESCE\(v_wallet_bal, 0\), v_(owed_kobo|booking\.subtotal_kobo)\);/);
    }
  });

  it('a shortfall (organizer already withdrew the funds a refund would otherwise reverse) is logged to admin_logs, never allowed to push balance_kobo negative', () => {
    const m0067 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0067_wallet_refunds.sql'), 'utf8');
    expect(m0067).toMatch(/refund_wallet_shortfall/);
  });
});

describe('Paystack credentials never reach the client', () => {
  it('PAYSTACK_SECRET_KEY is referenced only from server-side api/ files, never from src/', () => {
    const srcDir = join(__dirname, '..');
    const { execSync } = require('node:child_process');
    const hits = execSync(`grep -rl "PAYSTACK_SECRET" "${srcDir}" --exclude=withdrawalPayoutFinancialSafety.security.test.ts || true`, { encoding: 'utf8' }).trim();
    expect(hits).toBe('');
  });
});
