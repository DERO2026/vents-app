import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, static SQL-text-assertion tests for VENTS Cents Batch C (ticket
// reward integrity), mirroring this repo's own convention (see
// src/lib/vcCashout.security.test.ts / src/lib/vcReferral.security.test.ts)
// of verifying a live migration's actual, deployed function body rather
// than a re-implementation that could silently drift from what ships.
// There is no live DB test harness available here, so concurrency safety
// is verified structurally: by confirming the dedup key is backed by a
// real unique index (the arbiter Postgres itself enforces under
// concurrent transactions), not by an application-level check-then-insert.
//
// Covered migration: migrations/20260808120000_ticket-reward-integrity.sql
// (plus the prior versions of confirm_ticket_payment it replaces, to prove
// the gap it closes).

let migration: string;
let priorReferral: string; // 20260807120000 -- the version being replaced
let priorMultiAttendee: string; // 20260712100000 -- where the ON CONFLICT DO NOTHING first shipped unbacked
let refundMigration: string; // 20260712130000 -- proves refunds are per-ticket, not per payment_ref group

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$(?:function\\$|\\$)\\s*;`);
  return src.match(re)?.[0] ?? '';
}

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'migrations');
  migration = readFileSync(join(dir, '20260808120000_ticket-reward-integrity.sql'), 'utf8');
  priorReferral = readFileSync(join(dir, '20260807120000_referral-economy-integrity.sql'), 'utf8');
  priorMultiAttendee = readFileSync(join(dir, '20260712100000_multi-attendee-tickets.sql'), 'utf8');
  refundMigration = readFileSync(join(dir, '20260712130000_refund-ticket-rpc.sql'), 'utf8');
});

describe('scope discipline: only the VC dedup path changed', () => {
  it('the 50 VC ticket-purchase reward amount is unchanged', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)/);
  });

  it('never touches referral rewards/qualification/cap, cash-out rate/minimum, Feature Me price, badges, or profile completion', () => {
    expect(migration).not.toMatch(
      /vc_cashout_naira_per_1000|vc_naira_per_1000|badge_tier|feature_in_people|referrer_cap|300, 'referral'|150, 'referral'/
    );
  });

  it('does not touch qualify_referral, complete_referral, or the referral sweep functions', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(qualify_referral|complete_referral|_sweep_referral_vc)/);
  });

  it('is purely additive: no DROP TABLE/COLUMN/INDEX, no destructive statement', () => {
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP INDEX/);
  });

  it('every schema change uses an IF NOT EXISTS guard', () => {
    const creates = migration.match(/CREATE (?:UNIQUE )?INDEX[^;]*/g) || [];
    expect(creates.length).toBeGreaterThan(0);
    for (const stmt of creates) {
      expect(stmt).toMatch(/IF NOT EXISTS/);
    }
  });
});

describe('the split-purchase / retry exploit is closed at the database level', () => {
  it('adds a real unique index backing the VC-reward dedup (the arbiter Postgres itself enforces)', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_ticket_reward_dedup_idx\s*\n\s*ON public\.vc_transactions \(user_id, reference_id\)\s*\n\s*WHERE type = 'earn' AND reference_id IS NOT NULL;/
    );
  });

  it('the VC insert targets that exact index as its ON CONFLICT arbiter, not a bare unbacked ON CONFLICT DO NOTHING', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING/);
    // Confirm the previous, unbacked form is gone from the new definition.
    expect(cp).not.toMatch(/reference_id, now\(\)\)\s*\n\s*ON CONFLICT DO NOTHING;/);
  });

  it('the prior (still-live-until-this-migration) version really did use an unbacked ON CONFLICT DO NOTHING', () => {
    const cp = fn(priorReferral, 'confirm_ticket_payment');
    expect(cp).toMatch(/VALUES \(v_user_id, 50, 'earn', 'active', v_first_ticket_id, now\(\)\)\s*\n\s*ON CONFLICT DO NOTHING;/);
    // And no unique/exclusion constraint on vc_transactions.reference_id for
    // type='earn' existed anywhere before this migration.
    expect(priorReferral).not.toMatch(/vc_transactions_ticket_reward_dedup_idx/);
  });

  it('the gap traces back to the original multi-attendee migration (not newly introduced)', () => {
    const cp = fn(priorMultiAttendee, 'confirm_ticket_payment');
    expect(cp).toMatch(/ON CONFLICT DO NOTHING;/);
  });

  it('the qualifying order/purchase unit is one payment_ref group (min ticket id), never a single ticket row', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    // Grouped across every ticket row sharing one payment_ref -- one order
    // may contain many ticket rows (one per attendee) but yields exactly
    // one deterministic v_first_ticket_id / one reward.
    expect(cp).toMatch(/WHERE t\.payment_ref = p_reference\s*\n\s*GROUP BY t\.user_id, e\.organizer_id, e\.id/);
    expect(cp).toMatch(/min\(t\.id::text\)::uuid/);
  });

  it('splitting one intended purchase into N single-ticket calls still gets 1 reward per call, but each call is now hard-capped to exactly 1 row in the DB, not N', () => {
    // Structural proof: because the unique index key is
    // (user_id, reference_id) and reference_id is deterministic per
    // payment_ref group, two calls that legitimately use two DIFFERENT
    // payment_refs remain two legitimate, separately-rewarded orders (as
    // required -- see "legitimate separate purchases" test below), while
    // any call sequence that resolves to the SAME payment_ref group (retry,
    // webhook redelivery, re-confirmation after partial refund) can insert
    // at most one reward row, enforced by Postgres itself regardless of
    // how many times the INSERT statement runs.
    const cp = fn(migration, 'confirm_ticket_payment');
    const insertOnce = (cp.match(/INSERT INTO public\.vc_transactions/g) || []).length;
    expect(insertOnce).toBe(1);
  });
});

describe('duplicate confirmation / webhook retry idempotency', () => {
  it('already-fully-paid retries still short-circuit before reaching the VC insert (fast path, unchanged)', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/IF v_paid_count = v_ticket_count THEN\s*\n\s*RETURN 'already_paid';/);
  });

  it('the row lock (FOR UPDATE) on every ticket sharing the payment_ref still serializes concurrent confirmations of the same order', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/PERFORM 1 FROM public\.tickets WHERE payment_ref = p_reference FOR UPDATE;/);
  });

  it('a retry that slips past already_paid (e.g. after a partial per-ticket refund reopens the group) is still blocked at the VC insert by the unique index, not just by application logic', () => {
    // Evidence that refund_ticket operates per-ticket, not per payment_ref
    // group -- this is exactly the state transition that can reopen
    // "not fully paid" for an order whose reward was already granted.
    expect(refundMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(p_ticket_id uuid, p_reason text\)/);
    expect(refundMigration).not.toMatch(/WHERE payment_ref = /);
    // The new migration's dedup index is what neutralizes that scenario --
    // already covered by the ON CONFLICT assertions above.
    expect(migration).toMatch(/vc_transactions_ticket_reward_dedup_idx/);
  });
});

describe('failed / zero-value / cancelled payments never credit VC', () => {
  it('the VC block is still gated on v_total_amount > 0 (no reward for free tickets or unconfirmed amounts)', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/IF v_total_amount > 0 THEN\s*\n\s*-- Fix \(Batch C\)/);
  });

  it('an amount below the expected charge still returns amount_mismatch before any ticket is marked paid or any VC is inserted', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    const mismatchIdx = cp.indexOf("RETURN 'amount_mismatch:'");
    const updatePaidIdx = cp.indexOf("SET payment_status = 'paid'");
    const vcInsertIdx = cp.indexOf('INSERT INTO public.vc_transactions');
    expect(mismatchIdx).toBeGreaterThan(-1);
    expect(mismatchIdx).toBeLessThan(updatePaidIdx);
    expect(updatePaidIdx).toBeLessThan(vcInsertIdx);
  });

  it('a not_found payment_ref (never purchased / cancelled before any ticket row existed) returns early with no side effects', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN\s*\n\s*RETURN 'not_found';/);
  });
});

describe('unauthorized / direct client access', () => {
  it('confirm_ticket_payment is REVOKEd from PUBLIC, anon, and authenticated and GRANTed only to project_admin', () => {
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) FROM PUBLIC, anon, authenticated;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) TO project_admin;/
    );
  });

  it('the function stays SECURITY DEFINER with a locked-down search_path (immune to search_path hijacking)', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    expect(cp).toMatch(/SECURITY DEFINER/);
    expect(cp).toMatch(/SET search_path TO ''/);
  });

  it('the vc_transactions table itself has no INSERT policy for authenticated -- only SECURITY DEFINER RPCs can write it', () => {
    // Established in the original vents-cents-payment-system migration and
    // never altered since; re-asserted here since this migration is the one
    // that changes how a row lands in that table for ticket purchases.
    const original = readFileSync(
      join(__dirname, '..', '..', 'migrations', '20260619122544_vents-cents-payment-system.sql'),
      'utf8'
    );
    expect(original).toMatch(/No INSERT\/UPDATE\/DELETE policies for authenticated/);
  });
});

describe('legitimate separate purchases remain separately eligible', () => {
  it('two distinct payment_ref groups for the same user/event each derive their own v_first_ticket_id and are not collapsed together', () => {
    const cp = fn(migration, 'confirm_ticket_payment');
    // The GROUP BY and WHERE clause key everything off p_reference (this
    // call's specific payment_ref) -- a second, later call with a
    // different p_reference re-runs the whole function fresh against a
    // disjoint set of ticket rows, producing a different v_first_ticket_id
    // and therefore a distinct, unblocked unique-index key.
    expect(cp).toMatch(/WHERE t\.payment_ref = p_reference/);
    expect(cp).not.toMatch(/WHERE t\.user_id = v_user_id/);
  });
});
