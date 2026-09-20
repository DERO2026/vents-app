import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, static SQL-text-assertion tests for the wallet-path companion to
// VENTS Cents Batch C (ticket reward integrity). confirm_ticket_payment_via_wallet
// (supabase/migrations/0075) had the exact same unbacked ON CONFLICT DO
// NOTHING bug as confirm_ticket_payment() (the card path, fixed in
// migrations/20260808120000_ticket-reward-integrity.sql). Fixed here in
// supabase/migrations/0083_wallet_ticket_reward_dedup.sql by re-pointing the
// wallet function's VC insert at the SAME shared unique index the card-path
// fix already created on vc_transactions -- no second index needed, since
// both functions derive reference_id the same order-stable way from the
// same `tickets` table. See that migration's header comment for the full
// analysis. As with the card-path test file, there is no live DB harness
// here, so concurrency safety is verified structurally: by confirming the
// dedup key is backed by a real unique index rather than an
// application-level check-then-insert.

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$(?:function\\$|\\$)\\s*;`);
  return src.match(re)?.[0] ?? '';
}

let walletFix: string; // supabase/migrations/0083 -- this fix
let priorWallet: string; // supabase/migrations/0075 -- the unbacked version being replaced
let cardFix: string; // root migrations/20260808120000 -- the card-path fix + shared index

beforeAll(() => {
  walletFix = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0083_wallet_ticket_reward_dedup.sql'),
    'utf8'
  );
  priorWallet = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0075_wallet_refund_fee_ledger_and_error_hardening.sql'),
    'utf8'
  );
  cardFix = readFileSync(
    join(__dirname, '..', '..', 'migrations', '20260808120000_ticket-reward-integrity.sql'),
    'utf8'
  );
});

describe('wallet path: the prior (still-live-until-this-migration) bug really existed', () => {
  it('0075 used an unbacked ON CONFLICT DO NOTHING on the VC insert with no arbiter', () => {
    const fnBody = fn(priorWallet, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(
      /VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)\s*\n\s*ON CONFLICT DO NOTHING;/
    );
  });

  it('0075 created no unique/exclusion constraint on vc_transactions for type=earn', () => {
    expect(priorWallet).not.toMatch(/vc_transactions_ticket_reward_dedup_idx/);
    expect(priorWallet).not.toMatch(/CREATE UNIQUE INDEX[^;]*vc_transactions/);
  });
});

describe('wallet path: the fix targets the exact same arbiter as the card path', () => {
  it('does not create a second/overlapping unique index -- reuses the card path\'s shared index', () => {
    expect(walletFix).not.toMatch(/CREATE (?:UNIQUE )?INDEX/);
  });

  it('the VC insert targets vc_transactions_ticket_reward_dedup_idx as its ON CONFLICT arbiter', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING/);
    expect(fnBody).not.toMatch(/reference_id, now\(\)\)\s*\n\s*ON CONFLICT DO NOTHING;/);
  });

  it('the card path (migrations/20260808120000) uses the identical ON CONFLICT clause text', () => {
    const cardBody = fn(cardFix, 'confirm_ticket_payment');
    const walletBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    const clause = /ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING/;
    expect(cardBody).toMatch(clause);
    expect(walletBody).toMatch(clause);
  });

  it('both functions derive reference_id identically: min(ticket id) grouped by one payment reference', () => {
    const cardBody = fn(cardFix, 'confirm_ticket_payment');
    const walletBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(cardBody).toMatch(/min\(t\.id::text\)::uuid/);
    expect(walletBody).toMatch(/min\(t\.id::text\)::uuid/);
    expect(cardBody).toMatch(/GROUP BY t\.user_id, e\.organizer_id, e\.id/);
    expect(walletBody).toMatch(/GROUP BY t\.user_id, e\.organizer_id, e\.id/);
    // Card groups by p_reference, wallet groups by p_payment_ref -- both are
    // "the one payment reference identifying this order", just named
    // differently per function's parameter.
    expect(cardBody).toMatch(/WHERE t\.payment_ref = p_reference/);
    expect(walletBody).toMatch(/WHERE t\.payment_ref = p_payment_ref/);
  });
});

describe('wallet path: duplicate confirmation / retry idempotency', () => {
  it('a wallet purchase grants exactly one 50 VC insert statement per function body', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    const inserts = (fnBody.match(/INSERT INTO public\.vc_transactions/g) || []).length;
    expect(inserts).toBe(1);
    expect(fnBody).toMatch(/VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)/);
  });

  it('already-fully-paid retries still short-circuit before reaching the VC insert (fast path, unchanged)', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/IF v_paid_count = v_ticket_count THEN\s*\n\s*RETURN 'already_paid';/);
  });

  it('the row lock (FOR UPDATE) on every ticket sharing the payment_ref still serializes concurrent confirmations of the same order', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/PERFORM 1 FROM public\.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;/);
  });

  it('a retry after a partial refund reopens the group is blocked at the VC insert by the shared unique index, not just application logic', () => {
    // refund_ticket (0075, left untouched -- this migration re-declares only
    // confirm_ticket_payment_via_wallet) operates on one ticket row
    // (p_ticket_id) at a time, not the whole payment_ref group -- the exact
    // state transition the card-path migration documents as reopening
    // "not fully paid" for an order whose reward was already granted.
    const refundBody = fn(priorWallet, 'refund_ticket');
    expect(refundBody).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(p_ticket_id uuid, p_reason text\)/);
    expect(refundBody).not.toMatch(/WHERE payment_ref = /);
    expect(walletFix).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING/);
  });

  it('the wallet spend itself is idempotent too (unchanged): a retried debit cannot double-charge the wallet', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(
      /ON CONFLICT \(reference_id\) WHERE \(type = 'spend' AND reference_id IS NOT NULL\) DO NOTHING/
    );
    expect(fnBody).toMatch(/IF v_tx_id IS NULL THEN\s*\n\s*RETURN 'already_paid';/);
  });
});

describe('wallet path: failed / insufficient-balance payments never credit VC', () => {
  it('insufficient balance returns before any ticket is marked paid or any VC inserted', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    const insufficientIdx = fnBody.indexOf("RETURN 'insufficient_balance:'");
    const updatePaidIdx = fnBody.indexOf("SET payment_status = 'paid', payment_method = 'wallet'");
    const vcInsertIdx = fnBody.indexOf('INSERT INTO public.vc_transactions');
    expect(insufficientIdx).toBeGreaterThan(-1);
    expect(insufficientIdx).toBeLessThan(updatePaidIdx);
    expect(updatePaidIdx).toBeLessThan(vcInsertIdx);
  });

  it('a not_found payment_ref returns early with no side effects', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN\s*\n\s*RETURN 'not_found';/);
  });

  it('the VC block is still gated on v_total_amount > 0 (no reward for free tickets)', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/IF v_total_amount > 0 THEN\s*\n\s*-- Fix: reference_id/);
  });
});

describe('wallet path: unauthorized / direct client access', () => {
  it('confirm_ticket_payment_via_wallet is REVOKEd from PUBLIC, anon, project_admin and GRANTed only to authenticated (caller-scoped by auth.uid())', () => {
    expect(walletFix).toMatch(
      /REVOKE ALL ON FUNCTION public\.confirm_ticket_payment_via_wallet\(text\) FROM PUBLIC, anon, authenticated, project_admin;/
    );
    expect(walletFix).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment_via_wallet\(text\) TO authenticated;/
    );
  });

  it('the function checks auth.uid() and rejects a payment_ref owned by a different user', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
    expect(fnBody).toMatch(
      /IF v_user_id IS DISTINCT FROM v_uid THEN\s*\n\s*RAISE EXCEPTION 'Not authorized for this payment reference';/
    );
  });

  it('stays SECURITY DEFINER with a locked-down search_path', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/SET search_path TO ''/);
  });
});

describe('wallet path: legitimate separate purchases remain separately eligible', () => {
  it('everything is keyed off p_payment_ref, not a bare user id -- two distinct orders never collapse', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/WHERE t\.payment_ref = p_payment_ref/);
    expect(fnBody).not.toMatch(/WHERE t\.user_id = v_user_id/);
  });
});

describe('cross-path: card and wallet purchases cannot collide with each other', () => {
  it('each path groups strictly by its own payment_ref -- a user with one card order and one wallet order gets two independent, disjoint ticket groups and two independent reference_ids', () => {
    // Both purchase_ticket() (card) and finalize_pending_purchase() (wallet
    // recovery path) mint a fresh, distinct payment_ref per checkout via
    // create_pending_purchase(); the two orders' `tickets` rows therefore
    // never share a payment_ref, so min(t.id) for one order's group can
    // never equal min(t.id) for the other's. The unique index key is
    // (user_id, reference_id) on the SAME vc_transactions table for both
    // writers, so this is what actually prevents a same-user collision --
    // verified here structurally rather than assumed.
    const cardBody = fn(cardFix, 'confirm_ticket_payment');
    const walletBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(cardBody).toMatch(/WHERE t\.payment_ref = p_reference/);
    expect(walletBody).toMatch(/WHERE t\.payment_ref = p_payment_ref/);
    // Neither function groups by a coarser key (e.g. bare user_id/event_id
    // without payment_ref) that could merge two separate orders together.
    expect(cardBody).not.toMatch(/GROUP BY t\.user_id, e\.id\)/);
    expect(walletBody).not.toMatch(/GROUP BY t\.user_id, e\.id\)/);
  });

  it('the dedup index used by both writers is the single shared vc_transactions_ticket_reward_dedup_idx (no per-path duplicate index)', () => {
    expect(cardFix).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_ticket_reward_dedup_idx/);
    expect(walletFix).not.toMatch(/CREATE (?:UNIQUE )?INDEX/);
  });
});

describe('scope discipline: only the VC dedup path changed in the wallet fix', () => {
  it('does not touch the 50 VC amount, wallet debit amount, or organizer credit amount', () => {
    const fnBody = fn(walletFix, 'confirm_ticket_payment_via_wallet');
    expect(fnBody).toMatch(/VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)/);
    expect(fnBody).toMatch(/v_expected_kobo := round\(v_total_amount \* \(1\.05 - COALESCE\(v_discount_pct, 0\) \/ 100\) \* 100\)::bigint;/);
    expect(fnBody).toMatch(/v_credit_kobo := floor\(v_total_amount \* 100\)::bigint;/);
  });

  it('is purely additive: no DROP TABLE/COLUMN/INDEX, no destructive statement', () => {
    expect(walletFix).not.toMatch(/DROP TABLE|DROP COLUMN|DROP INDEX/);
  });

  it('never touches referral rewards/qualification/cap, cash-out, Feature Me price, or badges', () => {
    expect(walletFix).not.toMatch(
      /vc_cashout_naira_per_1000|vc_naira_per_1000|badge_tier|feature_in_people|referrer_cap|qualify_referral|complete_referral/
    );
  });

  it('does not redeclare refund_ticket at all -- 0075\'s refund fee/notification hardening is left fully untouched', () => {
    expect(walletFix).not.toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket/);
  });
});
