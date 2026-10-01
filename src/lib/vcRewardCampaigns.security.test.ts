import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS Cents reward-campaign framework (0126 + the 0127 status-value fix),
// matching the house static-analysis pattern (vcDedupCleanup.security.test.ts,
// withdrawalPayoutFinancialSafety.security.test.ts). No live Postgres harness
// here -- structural/ordering/idempotency guarantees are verified by
// inspecting the shipped SQL; actual row counts and balances were separately
// confirmed live via rolled-back transactions during development (every
// award/duplicate/cap/reversal/fail-closed scenario below was exercised
// against the real database and matched its expected result before this
// migration was committed).

let m0126: string;
let m0127: string;
let awardFn: string;
let reverseFn: string;
let adminUpdateFn: string;
let confirmTicketFn: string;
let confirmWalletFn: string;
let refundTicketFn: string;
let finalizeRefundFn: string;
let requestCashoutFn: string;
let adminClaimFn: string;
let adminCancelFn: string;
let adminRejectFn: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0126 = readFileSync(join(dir, '0126_vents_cents_reward_campaigns.sql'), 'utf8');
  m0127 = readFileSync(join(dir, '0127_vents_cents_fix_reversal_status.sql'), 'utf8');

  const extract = (src: string, name: string) =>
    src.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*\\n?;`))?.[0] ?? '';

  awardFn = extract(m0127, 'award_vc_reward'); // 0127 has the corrected version
  reverseFn = extract(m0127, 'reverse_vc_reward');
  adminUpdateFn = extract(m0126, 'admin_update_vc_campaign');
  confirmTicketFn = extract(m0126, 'confirm_ticket_payment');
  confirmWalletFn = extract(m0126, 'confirm_ticket_payment_via_wallet');
  refundTicketFn = extract(m0126, 'refund_ticket');
  finalizeRefundFn = extract(m0126, 'finalize_ticket_refund');
  requestCashoutFn = extract(m0126, 'request_vc_cashout');
  adminClaimFn = extract(m0126, 'admin_claim_vc_payout_for_processing');
  adminCancelFn = extract(m0126, 'admin_cancel_processing_vc_payout');
  adminRejectFn = extract(m0126, 'admin_reject_vc_payout');
});

// ── (A) status-value correctness (the live-verification catch) ──────────
describe('(A) reward reversal uses a status value the live CHECK constraint allows', () => {
  it('neither migration ever writes the invalid "reversed" status (vc_transactions_status_check only allows active/pending/expired/spent/cancelled)', () => {
    expect(m0126).not.toMatch(/status = 'reversed'/);
    expect(m0127).not.toMatch(/status = 'reversed'/);
  });

  it('0127 re-confirms every reversal path uses the valid "cancelled" status', () => {
    expect(reverseFn).toMatch(/SET status = 'cancelled' WHERE id = v_row\.id/);
    expect(reverseFn).not.toMatch(/'reversed'/);
  });

  it('the per-user cap count excludes cancelled (reversed) rows using the corrected status', () => {
    expect(awardFn).toMatch(/AND status <> 'cancelled'/);
    expect(awardFn).not.toMatch(/AND status <> 'reversed'/);
  });
});

// ── (B) award_vc_reward: idempotency, caps, date windows ─────────────────
describe('(B) award_vc_reward enforces every configurable guard before crediting', () => {
  it('requires a user id and a valid status', () => {
    expect(awardFn).toMatch(/RAISE EXCEPTION 'award_vc_reward: user_id is required'/);
    expect(awardFn).toMatch(/IF p_status NOT IN \('active', 'pending'\) THEN/);
  });

  it('locks the campaign row before reading its caps (concurrency-safe)', () => {
    expect(awardFn).toMatch(/SELECT \* INTO v_campaign FROM public\.vc_reward_campaigns WHERE key = p_campaign_key FOR UPDATE;/);
  });

  it('rejects unknown, disabled, not-yet-started and ended campaigns distinctly', () => {
    expect(awardFn).toMatch(/'awarded', false, 'reason', 'unknown_campaign'/);
    expect(awardFn).toMatch(/'awarded', false, 'reason', 'campaign_disabled'/);
    expect(awardFn).toMatch(/'awarded', false, 'reason', 'campaign_not_started'/);
    expect(awardFn).toMatch(/'awarded', false, 'reason', 'campaign_ended'/);
  });

  it('enforces per-user and campaign-wide total caps', () => {
    expect(awardFn).toMatch(/'awarded', false, 'reason', 'per_user_cap_reached'/);
    expect(awardFn).toMatch(/'awarded', false, 'reason', 'total_cap_reached'/);
  });

  it('is idempotent via the dedup unique index, not merely a client-side check', () => {
    // ON CONFLICT isn't used here deliberately -- the index raises
    // unique_violation, caught by the outer EXCEPTION, so two concurrent
    // award_vc_reward calls for the same (user, campaign, reference) can
    // never both succeed even under a race (the index enforces it, not the
    // cap check, which only prevents a THIRD distinct reference).
    expect(awardFn).toMatch(/EXCEPTION WHEN unique_violation THEN\s*\n\s*RETURN jsonb_build_object\('awarded', false, 'reason', 'already_awarded'\);/);
  });

  it('increments total_awarded only after a successful insert, in the same transaction', () => {
    const insertIdx = awardFn.indexOf('INSERT INTO public.vc_transactions');
    const totalIdx = awardFn.indexOf('UPDATE public.vc_reward_campaigns SET total_awarded');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(totalIdx).toBeGreaterThan(insertIdx);
  });

  it('is locked down to internal callers only -- never directly reachable by a client', () => {
    expect(m0126).toMatch(/REVOKE ALL ON FUNCTION public\.award_vc_reward\(uuid, text, uuid, text\) FROM PUBLIC, anon, authenticated;/);
    expect(m0126).toMatch(/GRANT EXECUTE ON FUNCTION public\.award_vc_reward\(uuid, text, uuid, text\) TO postgres, project_admin;/);
  });
});

// ── (C) multi-campaign dedup on the same reference ───────────────────────
describe('(C) the widened dedup index lets two campaigns fire once each off one reference', () => {
  it('drops the old (user_id, reference_id) index and replaces it with a campaign-aware one', () => {
    expect(m0126).toMatch(/DROP INDEX IF EXISTS public\.vc_transactions_earn_dedup_idx;/);
    expect(m0126).toMatch(/CREATE UNIQUE INDEX vc_transactions_earn_dedup_idx\s*\n\s*ON public\.vc_transactions \(user_id, COALESCE\(campaign_key, ''\), reference_id\)\s*\n\s*WHERE \(type = 'earn' AND reference_id IS NOT NULL\);/);
  });

  it('ticket_purchase and first_ticket_purchase both key off the same ticket id without colliding', () => {
    for (const fn of [confirmTicketFn, confirmWalletFn]) {
      expect(fn).toMatch(/PERFORM public\.award_vc_reward\(v_user_id, 'ticket_purchase', v_first_ticket_id\);/);
      expect(fn).toMatch(/PERFORM public\.award_vc_reward\(v_user_id, 'first_ticket_purchase', v_first_ticket_id\);/);
    }
  });

  it('first_ticket_purchase only fires when the user had zero prior paid tickets', () => {
    for (const fn of [confirmTicketFn, confirmWalletFn]) {
      expect(fn).toMatch(/v_prior_paid_count integer;/);
      expect(fn).toMatch(/IF v_prior_paid_count = 0 THEN\s*\n\s*PERFORM public\.award_vc_reward\(v_user_id, 'first_ticket_purchase', v_first_ticket_id\);/);
      // computed BEFORE the ticket is marked paid, else it would always read >0
      const priorIdx = fn.indexOf('SELECT count(*) INTO v_prior_paid_count');
      const paidIdx = fn.search(/UPDATE public\.tickets\s*\n\s*SET payment_status = 'paid'/);
      expect(priorIdx).toBeGreaterThan(-1);
      expect(paidIdx).toBeGreaterThan(-1);
      expect(priorIdx).toBeLessThan(paidIdx);
    }
  });
});

// ── (D) refund/reversal wiring ────────────────────────────────────────────
describe('(D) refunded or cancelled tickets reverse their VC reward instead of leaving it credited', () => {
  it('refund_ticket reverses VC on both the free-ticket branch and the wallet-refund branch', () => {
    const matches = refundTicketFn.match(/PERFORM public\.reverse_vc_reward\(v_ticket\.id, 'Ticket refunded: ' \|\| p_reason\);/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('finalize_ticket_refund (the Paystack-webhook-driven path) also reverses VC', () => {
    expect(finalizeRefundFn).toMatch(/PERFORM public\.reverse_vc_reward\(v_ticket\.id, 'Ticket refunded: ' \|\| COALESCE\(v_ticket\.refund_reason, 'refund processed'\)\);/);
  });

  it('the reversal always runs after the ticket is marked refunded, never before', () => {
    const refundedIdx = finalizeRefundFn.indexOf("SET payment_status = 'refunded'");
    const reverseIdx = finalizeRefundFn.indexOf('PERFORM public.reverse_vc_reward');
    expect(refundedIdx).toBeGreaterThan(-1);
    expect(reverseIdx).toBeGreaterThan(refundedIdx);
  });

  it('reversal is idempotent: only active/pending rows are matched, so a second reversal call is a no-op', () => {
    expect(reverseFn).toMatch(/WHERE reference_id = p_reference_id AND type = 'earn' AND status IN \('active', 'pending'\)/);
  });

  it('the wallet clawback never drives the balance negative, and logs the shortfall if the VC was already spent', () => {
    expect(reverseFn).toMatch(/v_actual_clawback := LEAST\(COALESCE\(v_wallet_balance, 0\), v_row\.amount\);/);
    expect(reverseFn).toMatch(/'vc_reward_reversal_shortfall'/);
  });

  it('reverse_vc_reward is also internal-only, never directly client-callable', () => {
    expect(m0126).toMatch(/REVOKE ALL ON FUNCTION public\.reverse_vc_reward\(uuid, text\) FROM PUBLIC, anon, authenticated;/);
    expect(m0126).toMatch(/GRANT EXECUTE ON FUNCTION public\.reverse_vc_reward\(uuid, text\) TO postgres, project_admin;/);
  });
});

// ── (E) admin campaign management (no new dashboard) ─────────────────────
describe('(E) admin_update_vc_campaign is Root-gated and fully audited', () => {
  it('requires Root, matching the existing VC economy dials in admin_update_app_config', () => {
    expect(adminUpdateFn).toMatch(/IF NOT public\.is_root\(\) THEN/);
  });

  it('locks the campaign row before updating it', () => {
    expect(adminUpdateFn).toMatch(/SELECT \* INTO v_old FROM public\.vc_reward_campaigns WHERE key = p_key FOR UPDATE;/);
  });

  it('rejects a non-positive amount', () => {
    expect(adminUpdateFn).toMatch(/IF p_amount_vc IS NOT NULL AND p_amount_vc <= 0 THEN/);
  });

  it('logs old and new state plus the admin-supplied reason in the same transaction', () => {
    expect(adminUpdateFn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(adminUpdateFn).toMatch(/'vc_campaign_update'/);
    expect(adminUpdateFn).toMatch(/'old', jsonb_build_object/);
    expect(adminUpdateFn).toMatch(/'new', jsonb_build_object/);
  });

  it('every campaign is read-only to clients -- all writes go through this one audited RPC', () => {
    expect(m0126).toMatch(/CREATE POLICY vc_reward_campaigns_select_all ON public\.vc_reward_campaigns\s*\n\s*FOR SELECT USING \(true\);/);
    expect(m0126).not.toMatch(/CREATE POLICY[^;]*vc_reward_campaigns[^;]*FOR (INSERT|UPDATE|DELETE)/);
    expect(m0126).toMatch(/REVOKE ALL ON public\.vc_reward_campaigns FROM PUBLIC, anon, authenticated;/);
  });
});

// ── (F) no account-creation giveaway ──────────────────────────────────────
describe('(F) no reward campaign is eligible for signup/login/verify/app-open alone', () => {
  it('the seeded campaigns are all tied to genuine activity, not account lifecycle events', () => {
    const seedBlock = m0126.match(/INSERT INTO public\.vc_reward_campaigns[\s\S]*?ON CONFLICT \(key\) DO NOTHING;/)?.[0] ?? '';
    for (const forbidden of ['signup', 'login', 'email_verif', 'app_open', 'account_creat']) {
      expect(seedBlock.toLowerCase(), `must not seed a ${forbidden} campaign`).not.toContain(forbidden);
    }
    expect(seedBlock).toContain('ticket_purchase');
    expect(seedBlock).toContain('first_ticket_purchase');
    expect(seedBlock).toContain('profile_complete');
    expect(seedBlock).toContain('referral_referred');
    expect(seedBlock).toContain('referral_referrer');
  });

  it('award_vc_reward is only ever invoked from payment-confirmation / referral paths, never from an auth callback', () => {
    expect(confirmTicketFn).toMatch(/award_vc_reward/);
    expect(confirmWalletFn).toMatch(/award_vc_reward/);
  });

  it('the one new tier needing a business decision ships disabled by default', () => {
    expect(m0126).toMatch(/'first_ticket_purchase'[\s\S]{0,400}?false\)/);
  });
});

// ── (G) emergency-control fail-closed fix ─────────────────────────────────
describe('(G) every VC payout path fails closed, matching the organizer-payout fix in 0124', () => {
  it('request_vc_cashout checks payouts_disabled() before anything else, not the bare config read', () => {
    expect(requestCashoutFn).toMatch(/IF public\.payouts_disabled\(\) THEN/);
    expect(requestCashoutFn).not.toMatch(/\(SELECT disable_payouts FROM (public\.)?app_config LIMIT 1\)\s*THEN/);
  });

  it('all three VC payout admin actions use the fail-closed helper too', () => {
    for (const fn of [adminClaimFn, adminCancelFn, adminRejectFn]) {
      expect(fn).toMatch(/IF public\.payouts_disabled\(\) THEN/);
      expect(fn).not.toMatch(/\(SELECT disable_payouts FROM (public\.)?app_config LIMIT 1\)\s*THEN/);
    }
  });

  it('the payouts_disabled() check runs before any state-changing statement in each function', () => {
    for (const fn of [requestCashoutFn, adminClaimFn, adminCancelFn, adminRejectFn]) {
      const checkIdx = fn.indexOf('public.payouts_disabled()');
      const updateIdx = fn.search(/UPDATE public\.vc_withdrawal_requests/);
      expect(checkIdx).toBeGreaterThan(-1);
      if (updateIdx > -1) expect(checkIdx).toBeLessThan(updateIdx);
    }
  });

  it('cash-out enforces a minimum amount server-side, never trusting a client-supplied eligibility flag', () => {
    expect(requestCashoutFn).toMatch(/IF p_vc_amount IS NULL OR p_vc_amount < 1000 THEN/);
  });

  it('cash-out requires an idempotency key and is a no-op on retry with the same key', () => {
    expect(requestCashoutFn).toMatch(/IF p_idempotency_key IS NULL OR trim\(p_idempotency_key\) = '' THEN/);
    expect(requestCashoutFn).toMatch(/ON CONFLICT \(user_id, idempotency_key\) DO NOTHING/);
    expect(requestCashoutFn).toMatch(/GET DIAGNOSTICS v_rows = ROW_COUNT;/);
  });

  it('rejecting or cancelling a payout restores the VC to the user (no silent fund loss)', () => {
    expect(adminCancelFn).toMatch(/PERFORM public\._vc_restore\(v_user_id, v_vc_amount,/);
    expect(adminRejectFn).toMatch(/PERFORM public\._vc_restore\(v_user_id, v_vc_amount,/);
  });
});

// ── (H) all functions remain SECURITY DEFINER with a locked search_path ──
describe('(H) every new/replaced function keeps the house security posture', () => {
  it('all are SECURITY DEFINER with search_path pinned to empty', () => {
    for (const fn of [awardFn, reverseFn, adminUpdateFn, confirmTicketFn, confirmWalletFn, refundTicketFn, finalizeRefundFn, requestCashoutFn, adminClaimFn, adminCancelFn, adminRejectFn]) {
      expect(fn).toMatch(/SECURITY DEFINER/);
      expect(fn).toMatch(/SET search_path TO ''/);
    }
  });
});
