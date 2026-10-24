import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0192_platform_fee_accounting_foundation.sql -- the
// Phase 1 schema foundation for VENTS revenue accounting (prerequisite for
// a future, NOT-yet-implemented recruiter-commission system). This suite
// is static: it reads the literal migration SQL and asserts on its text,
// following the same convention as walletRefundFeeLedger.security.test.ts.
// It does NOT execute SQL against a live database.
//
// Deferred to later phases (explicitly NOT covered here, since the
// underlying functions aren't modified by this migration):
//   - refund_ticket / finalize_ticket_refund inserting platform_fee_reversals
//     rows (Phase 2: "record formal reversal entries in the same
//     transaction as existing refund/cancellation logic").
//   - Any dispute webhook handling writing to payment_disputes, or a
//     merchant-won resolution restarting the 30-day hold (Phase 3).
//   - The cron sweep setting qualifying_status to 'qualified'/'disqualified'
//     (Phase 4).
//   - Service-booking completed_at / fallback-formula logic beyond the bare
//     column existing (Phase 4 designs the fallback formula).

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0192_platform_fee_accounting_foundation.sql'), 'utf8');
});

function allocateFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.allocate_ticket_platform_fees\(p_payment_ref text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function confirmFn(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment\(p_reference text, p_amount_kobo bigint\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

describe('0192: new columns are additive and never backfilled', () => {
  it('adds tickets.platform_fee_kobo as nullable, with no unconditional/unscoped backfill of existing rows', () => {
    expect(migration).toMatch(/ADD COLUMN platform_fee_kobo bigint NULL/);
    // The only places platform_fee_kobo is ever written are scoped to a single
    // payment_ref AND payment_status = 'paid' AND platform_fee_kobo IS NULL
    // (allocate_ticket_platform_fees) -- never an unscoped UPDATE across all tickets.
    const unscopedBackfill = /UPDATE public\.tickets\s+SET platform_fee_kobo = [^N][\s\S]{0,5}?;/g;
    const matches = migration.match(unscopedBackfill) ?? [];
    for (const m of matches) {
      expect(m).toMatch(/payment_ref = p_payment_ref/);
    }
  });

  it('adds tickets.qualifying_status defaulting to pending with a strict CHECK', () => {
    expect(migration).toMatch(/ADD COLUMN qualifying_status text NOT NULL DEFAULT 'pending'/);
    expect(migration).toMatch(/tickets_qualifying_status_check CHECK \(qualifying_status IN \('pending', 'qualifying', 'qualified', 'disqualified'\)\)/);
  });

  it('adds service_bookings.completed_at (nullable) and qualifying_status, without touching fee_kobo', () => {
    expect(migration).toMatch(/ADD COLUMN completed_at timestamptz NULL/);
    expect(migration).toMatch(/service_bookings_qualifying_status_check CHECK \(qualifying_status IN \('pending', 'qualifying', 'qualified', 'disqualified'\)\)/);
    const alterServiceBookingsBlock = migration.match(/ALTER TABLE public\.service_bookings\b[\s\S]*?;/g)?.join('\n') ?? '';
    expect(alterServiceBookingsBlock).not.toMatch(/\bfee_kobo\b/);
  });

  it('both platform_fee_absorbed_kobo columns are NOT NULL DEFAULT 0 with a non-negative CHECK', () => {
    expect(migration).toMatch(/tickets_platform_fee_absorbed_kobo_nonneg CHECK \(platform_fee_absorbed_kobo >= 0\)/);
    expect(migration).toMatch(/service_bookings_platform_fee_absorbed_kobo_nonneg CHECK \(platform_fee_absorbed_kobo >= 0\)/);
  });
});

describe('0192: platform_fee_reversals is an append-only ledger', () => {
  it('has no UPDATE or DELETE policy anywhere in the migration', () => {
    const tableBlock = migration.match(/CREATE TABLE public\.platform_fee_reversals[\s\S]*?(?=CREATE TABLE public\.payment_disputes)/)?.[0] ?? '';
    expect(tableBlock).not.toMatch(/FOR UPDATE/);
    expect(tableBlock).not.toMatch(/FOR DELETE/);
  });

  it('writes are admin-gated (is_admin()) and reads are scoped to admins plus the owning organizer/provider', () => {
    expect(migration).toMatch(/CREATE POLICY platform_fee_reversals_admin_write ON public\.platform_fee_reversals\s*\n\s*FOR INSERT WITH CHECK \(public\.is_admin\(\)\)/);
    expect(migration).toMatch(/CREATE POLICY platform_fee_reversals_select_own_ticket[\s\S]*?e\.organizer_id = auth\.uid\(\)/);
    expect(migration).toMatch(/CREATE POLICY platform_fee_reversals_select_own_booking[\s\S]*?sp\.user_id = auth\.uid\(\)/);
  });

  it('grants are least-privilege: REVOKE ALL from PUBLIC/anon/authenticated, then only SELECT+INSERT to project_admin', () => {
    expect(migration).toMatch(/REVOKE ALL ON public\.platform_fee_reversals FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON public\.platform_fee_reversals TO project_admin;/);
  });

  it('has a partial unique index guarding idempotent inserts, mirroring user_wallet_transactions convention', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX platform_fee_reversals_dedupe_idx\s*\n\s*ON public\.platform_fee_reversals \(source_type, source_id, reversal_type, reference_id\)\s*\n\s*WHERE reference_id IS NOT NULL;/);
  });

  it('amount_kobo is constrained non-negative and reversal_type/source_type are enum-checked', () => {
    expect(migration).toMatch(/amount_kobo bigint NOT NULL CHECK \(amount_kobo >= 0\)/);
    expect(migration).toMatch(/reversal_type text NOT NULL CHECK \(reversal_type IN \('refund', 'chargeback', 'dispute_loss', 'other'\)\)/);
    expect(migration).toMatch(/source_type text NOT NULL CHECK \(source_type IN \('ticket', 'service_booking'\)\)/);
  });
});

describe('0192: payment_disputes schema', () => {
  it('requires a unique paystack_dispute_id and constrains status to the modeled resolution states', () => {
    expect(migration).toMatch(/CONSTRAINT payment_disputes_paystack_dispute_id_uniq UNIQUE \(paystack_dispute_id\)/);
    expect(migration).toMatch(/status text NOT NULL DEFAULT 'created' CHECK \(status IN \('created', 'merchant_won', 'merchant_lost', 'resolved_other'\)\)/);
  });

  it('least-privilege grants: no anon/authenticated access, only project_admin', () => {
    expect(migration).toMatch(/REVOKE ALL ON public\.payment_disputes FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE ON public\.payment_disputes TO project_admin;/);
  });

  it('RLS is enabled with an admin-write policy', () => {
    expect(migration).toMatch(/ALTER TABLE public\.payment_disputes ENABLE ROW LEVEL SECURITY;/);
    expect(migration).toMatch(/CREATE POLICY payment_disputes_admin_all ON public\.payment_disputes\s*\n\s*FOR ALL USING \(public\.is_admin\(\)\) WITH CHECK \(public\.is_admin\(\)\);/);
  });
});

describe('allocate_ticket_platform_fees: deterministic largest-remainder apportionment', () => {
  it('locks the order\'s ticket rows before reading, same convention as confirm_ticket_payment', () => {
    const fn = allocateFn();
    expect(fn).toMatch(/PERFORM 1 FROM public\.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;/);
  });

  it('is a no-op once every paid row in the order already has platform_fee_kobo set (idempotent retry)', () => {
    const fn = allocateFn();
    expect(fn).toMatch(/IF NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.tickets\s*\n\s*WHERE payment_ref = p_payment_ref AND payment_status = 'paid' AND platform_fee_kobo IS NULL\s*\n\s*\) THEN\s*\n\s*RETURN;\s*\n\s*END IF;/);
  });

  it('reads the authoritative fee from organizer_transactions.metadata, never recomputing the surcharge formula', () => {
    const fn = allocateFn();
    expect(fn).toMatch(/\(ot\.metadata->>'buyer_fee_kobo'\)::bigint INTO v_buyer_fee_kobo/);
    expect(fn).not.toMatch(/1\.05/);
  });

  it('zero-amount / unrecorded-fee orders get every row set to 0, not left NULL (so they count as allocated)', () => {
    const fn = allocateFn();
    expect(fn).toMatch(/IF v_buyer_fee_kobo IS NULL OR v_total_amount IS NULL OR v_total_amount <= 0 THEN/);
    expect(fn).toMatch(/SET platform_fee_kobo = 0\s*\n\s*WHERE payment_ref = p_payment_ref AND payment_status = 'paid' AND platform_fee_kobo IS NULL;/);
  });

  it('computes a floor share per row and distributes the exact remainder by largest fractional part, tie-broken by id', () => {
    const fn = allocateFn();
    expect(fn).toMatch(/floor\(v_buyer_fee_kobo \* t\.amount \/ v_total_amount\)::bigint AS floor_share/);
    expect(fn).toMatch(/row_number\(\) OVER \(ORDER BY \(raw_share - floor_share\) DESC, id ASC\) AS rn/);
    expect(fn).toMatch(/v_buyer_fee_kobo - coalesce\(sum\(floor_share\), 0\) INTO v_remainder FROM weighted;/);
    expect(fn).toMatch(/SET platform_fee_kobo = r\.floor_share \+ CASE WHEN r\.rn <= v_remainder THEN 1 ELSE 0 END/);
  });

  it('only ever updates rows where platform_fee_kobo IS NULL -- never overwrites an already-allocated row', () => {
    const fn = allocateFn();
    // every SELECT feeding the UPDATE paths filters on platform_fee_kobo IS NULL
    const weightedCte = fn.match(/WITH weighted AS[\s\S]*?ranked AS/)?.[0] ?? '';
    expect(weightedCte).toMatch(/t\.platform_fee_kobo IS NULL/);
  });

  it('is granted only to project_admin, matching confirm_ticket_payment\'s own grant shape', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.allocate_ticket_platform_fees\(text\) FROM PUBLIC, anon, authenticated, project_admin;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.allocate_ticket_platform_fees\(text\) TO project_admin;/);
  });
});

describe('confirm_ticket_payment: allocation wired in without changing existing behavior', () => {
  it('calls the allocator exactly once on the happy (newly confirmed) path, right after the organizer wallet credit', () => {
    const fn = confirmFn();
    const afterCredit = fn.split('PERFORM public.credit_organizer_wallet(')[1] ?? '';
    expect(afterCredit).toMatch(/PERFORM public\.allocate_ticket_platform_fees\(p_reference\);/);
  });

  it('also calls the allocator on the already_paid short-circuit, so a retry still closes any allocation gap', () => {
    const fn = confirmFn();
    expect(fn).toMatch(/IF v_paid_count = v_ticket_count THEN\s*\n[\s\S]*?PERFORM public\.allocate_ticket_platform_fees\(p_reference\);\s*\n\s*RETURN 'already_paid';/);
  });

  it('leaves the amount-mismatch, promo-code, VC-reward, and notification logic byte-identical to the live function', () => {
    const fn = confirmFn();
    expect(fn).toMatch(/RETURN 'amount_mismatch:' \|\| v_expected_kobo::text \|\| ':' \|\| p_amount_kobo::text;/);
    expect(fn).toMatch(/UPDATE public\.promo_codes SET current_uses = current_uses \+ 1 WHERE upper\(code\) = v_promo_code;/);
    expect(fn).toMatch(/PERFORM public\.award_vc_reward\(v_user_id, 'ticket_purchase', v_first_ticket_id\);/);
    expect(fn).toMatch(/'Ticket confirmed! 🎉'/);
  });

  it('still returns not_found for an unknown payment_ref before any allocation is attempted', () => {
    const fn = confirmFn();
    expect(fn).toMatch(/IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN\s*\n\s*RETURN 'not_found';\s*\n\s*END IF;/);
  });

  it('grants are unchanged from the live function: project_admin only, nothing for anon/authenticated', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_ticket_payment\(text, bigint\) FROM PUBLIC, anon, authenticated, project_admin;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment\(p_reference text, p_amount_kobo bigint\) TO project_admin;/);
  });
});

describe('platform_fee_reconciliation: read-only mismatch/incompleteness detector', () => {
  it('flags is_incomplete whenever any paid ticket in the order still has a NULL allocation', () => {
    expect(migration).toMatch(/\(count\(\*\) FILTER \(WHERE t\.platform_fee_kobo IS NULL\) > 0\) AS is_incomplete/);
  });

  it('flags is_mismatched only once fully allocated, comparing the summed allocation against the authoritative fee', () => {
    expect(migration).toMatch(/coalesce\(sum\(t\.platform_fee_kobo\), 0\) <> ot\.buyer_fee_kobo/);
  });

  it('is a plain view (no SECURITY DEFINER function, no write path) and grants only SELECT to project_admin', () => {
    expect(migration).toMatch(/CREATE VIEW public\.platform_fee_reconciliation AS/);
    expect(migration).toMatch(/REVOKE ALL ON public\.platform_fee_reconciliation FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT SELECT ON public\.platform_fee_reconciliation TO project_admin;/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.platform_fee_reconciliation/);
  });
});

describe('0192: scope discipline', () => {
  it('does not touch refund_ticket, finalize_ticket_refund, or define any dispute-webhook-handling function (deferred to Phases 2-4)', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.finalize_ticket_refund/);
    // payment_disputes' own doc comment forward-references Phase 3's
    // charge.dispute.* handling -- that's documentation, not an implementation.
    // What must not exist yet is any function that actually processes one.
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION[\s\S]{0,400}charge\.dispute/);
  });

  it('defines no recruiter-commission table, column, or function (mentions in comments describing future work are fine)', () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]*(?:recruiter|commission)/i);
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION[^;]*(?:recruiter|commission)/i);
    expect(migration).not.toMatch(/ADD COLUMN[^;]*(?:recruiter|commission)/i);
  });
});
