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
// Also covers (added in a follow-up review pass): the qualifying_status
// lifecycle documentation/transition table and its explicit
// never-sufficient-alone-for-payout guard, the reconciliation view's
// explicit reconciliation_status classification (replacing a prior
// ORDER BY ... LIMIT 1 silent row-pick), and a JS simulation of the
// largest-remainder allocation formula for realistic multi-ticket
// scenarios (see the "Allocation-correctness simulation" section below
// for exactly what that simulation can and cannot prove).
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

describe('platform_fee_reconciliation: explicit reconciliation_status, no silent row-picking', () => {
  function reconciliationSql(): string {
    return migration.match(/CREATE VIEW public\.platform_fee_reconciliation AS[\s\S]*?LEFT JOIN authoritative a ON a\.payment_ref = tt\.payment_ref;/)?.[0] ?? '';
  }

  it('does not use ORDER BY ... LIMIT 1 to pick an authoritative row', () => {
    const sql = reconciliationSql();
    expect(sql).not.toMatch(/ORDER BY[\s\S]*?LIMIT 1/);
  });

  it('pre-aggregates both the tickets side and the organizer_transactions side to one row per payment_ref before joining, so the join cannot fan out ticket rows across multiple transaction rows', () => {
    const sql = reconciliationSql();
    const authoritativeCte = sql.match(/authoritative AS \([\s\S]*?\),\n\s*ticket_totals/)?.[0] ?? '';
    const ticketTotalsCte = sql.match(/ticket_totals AS \([\s\S]*?\)\n\)/)?.[0] ?? sql.match(/ticket_totals AS \([\s\S]*?GROUP BY t\.payment_ref\s*\n\)/)?.[0] ?? '';
    expect(authoritativeCte).toMatch(/GROUP BY 1/);
    expect(ticketTotalsCte).toMatch(/GROUP BY t\.payment_ref/);
    // the final SELECT joins two already-grouped CTEs 1:1 on payment_ref, not raw tables
    expect(sql).toMatch(/FROM ticket_totals tt\s*\n\s*LEFT JOIN authoritative a ON a\.payment_ref = tt\.payment_ref;/);
  });

  it('flags missing_authoritative_fee when zero organizer_transactions rows carry the payment_ref', () => {
    expect(migration).toMatch(/WHEN a\.fee_record_count IS NULL OR a\.fee_record_count = 0 THEN 'missing_authoritative_fee'/);
  });

  it('flags duplicate_authoritative_fee when more than one organizer_transactions row carries the payment_ref, instead of silently picking one', () => {
    expect(migration).toMatch(/WHEN a\.fee_record_count > 1 THEN 'duplicate_authoritative_fee'/);
  });

  it('flags unallocated whenever any paid ticket in the order still has a NULL allocation (checked only after the fee-record-count cases)', () => {
    expect(migration).toMatch(/WHEN tt\.unallocated_ticket_count > 0 THEN 'unallocated'/);
  });

  it('flags mismatch only once fully allocated with exactly one authoritative fee record, comparing the summed allocation against it', () => {
    expect(migration).toMatch(/WHEN coalesce\(tt\.allocated_total_kobo, 0\) <> a\.buyer_fee_kobo THEN 'mismatch'/);
  });

  it('is a plain view (no SECURITY DEFINER function, no write path) and grants only SELECT to project_admin', () => {
    expect(migration).toMatch(/CREATE VIEW public\.platform_fee_reconciliation AS/);
    expect(migration).toMatch(/REVOKE ALL ON public\.platform_fee_reconciliation FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT SELECT ON public\.platform_fee_reconciliation TO project_admin;/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.platform_fee_reconciliation/);
  });

  it('is documented as informational only -- never an authorization gate for any future recruiter-commission check', () => {
    expect(migration).toMatch(/COMMENT ON VIEW public\.platform_fee_reconciliation IS 'Read-only, informational only \(not an authorization gate/);
  });
});

describe('qualifying_status: lifecycle is documented and cannot be mistaken for a payout authorization signal', () => {
  it('documents all four states and the full allowed-transition table in a comment block, including the merchant-won-dispute restart path', () => {
    expect(migration).toMatch(/QUALIFYING-STATUS LIFECYCLE/);
    expect(migration).toMatch(/pending\s+->\s*qualifying/);
    expect(migration).toMatch(/qualifying\s+->\s*qualified/);
    expect(migration).toMatch(/qualifying\s+->\s*disqualified/);
    expect(migration).toMatch(/qualified\s+->\s*disqualified/);
    expect(migration).toMatch(/disqualified\s+->\s*qualifying/);
  });

  it('explicitly states qualifying_status is never sufficient on its own to authorize a recruiter-commission payout', () => {
    expect(migration).toMatch(/must NEVER be read as sufficient, on its own, to\s*\n--\s*authorize a recruiter-commission payout/);
  });

  it('no SECURITY DEFINER function or view in this migration reads qualifying_status to gate a monetary action', () => {
    // platform_fee_reconciliation (the only view defined here) never references qualifying_status
    const reconciliationBlock = migration.match(/CREATE VIEW public\.platform_fee_reconciliation AS[\s\S]*?LEFT JOIN authoritative a ON a\.payment_ref = tt\.payment_ref;/)?.[0] ?? '';
    expect(reconciliationBlock).not.toMatch(/qualifying_status/);
    // allocate_ticket_platform_fees and confirm_ticket_payment (the only functions defined/replaced here)
    // never branch on qualifying_status either -- this migration only sets the column's default and CHECK.
    const allocateFnSql = allocateFn();
    const confirmFnSql = confirmFn();
    expect(allocateFnSql).not.toMatch(/qualifying_status/);
    expect(confirmFnSql).not.toMatch(/qualifying_status/);
  });

  it('service_bookings.qualifying_status comment cross-references the same lifecycle and the same payout-authorization warning', () => {
    expect(migration).toMatch(/COMMENT ON COLUMN public\.service_bookings\.qualifying_status IS 'Same lifecycle and states as tickets\.qualifying_status/);
    expect(migration).toMatch(/NOT sufficient on its own to authorize any recruiter-commission payout/);
  });
});

// ---------------------------------------------------------------------
// Allocation-correctness simulation
// ---------------------------------------------------------------------
// IMPORTANT: this suite has no live database and cannot execute
// allocate_ticket_platform_fees() itself. The function below is an
// independent re-implementation, in JS, of the EXACT algorithm documented
// in the migration's "ALLOCATION-BASIS DESIGN NOTE" and asserted against
// the migration's SQL text above (floor share + largest-fractional-
// remainder distribution, ties broken by ascending id). It verifies the
// algorithm's math is correct and deterministic for realistic multi-ticket
// scenarios that do not exist in production today -- as of this migration,
// live data has zero paid, non-free, multi-ticket orders to validate
// against (verified via a live query: 99 single-ticket orders and 3
// multi-ticket orders, all three free/amount=0). These are therefore
// simulated/synthetic verifications of the allocation formula, not
// integration tests against the real allocate_ticket_platform_fees()
// SQL function -- that gap can only close once either (a) a real
// multi-ticket paid order occurs in production, or (b) a local/branch
// Postgres instance is available to this test suite to execute the
// actual function.
function simulateAllocation(buyerFeeKobo: number, tickets: { id: string; amount: number }[]): Map<string, number> {
  const totalAmount = tickets.reduce((s, t) => s + t.amount, 0);
  const result = new Map<string, number>();
  if (totalAmount <= 0 || buyerFeeKobo <= 0) {
    for (const t of tickets) result.set(t.id, 0);
    return result;
  }
  const shares = tickets.map((t) => {
    const raw = (buyerFeeKobo * t.amount) / totalAmount;
    const floorShare = Math.floor(raw);
    return { id: t.id, floorShare, frac: raw - floorShare };
  });
  const floorTotal = shares.reduce((s, x) => s + x.floorShare, 0);
  let remainder = buyerFeeKobo - floorTotal;
  const ranked = [...shares].sort((a, b) => (b.frac - a.frac) || a.id.localeCompare(b.id));
  for (const s of ranked) {
    result.set(s.id, s.floorShare + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }
  return result;
}

function sumOf(m: Map<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

describe('allocation formula simulation: exact-sum and determinism across realistic multi-ticket scenarios', () => {
  it('unequal ticket amounts within one order: each row gets a proportional share and the total matches exactly', () => {
    const tickets = [
      { id: 'a', amount: 1000 },
      { id: 'b', amount: 2000 },
      { id: 'c', amount: 3000 },
    ];
    const result = simulateAllocation(300, tickets); // 5% of 6000 kobo-equivalent, simplified
    expect(sumOf(result)).toBe(300);
    // proportional ordering preserved: larger amount never gets a strictly smaller share than a smaller amount
    expect(result.get('c')!).toBeGreaterThanOrEqual(result.get('b')!);
    expect(result.get('b')!).toBeGreaterThanOrEqual(result.get('a')!);
  });

  it('discounted order: weights are still each row\'s own persisted amount (discount is already baked into the authoritative buyer_fee_kobo, not re-applied per row)', () => {
    const tickets = [
      { id: 'a', amount: 500 },
      { id: 'b', amount: 500 },
    ];
    // buyer_fee_kobo here stands in for whatever confirm_ticket_payment already
    // computed net of the order's discount_percentage -- the allocator never
    // re-applies a discount itself, it only splits this number.
    const result = simulateAllocation(47, tickets);
    expect(sumOf(result)).toBe(47);
    // equal amounts within rounding error of an odd total: shares differ by at most 1 kobo
    const vals = [...result.values()];
    expect(Math.abs(vals[0] - vals[1])).toBeLessThanOrEqual(1);
  });

  it('zero-priced row mixed with non-zero rows in the same order: the zero row gets exactly 0, never a negative or NaN share', () => {
    const tickets = [
      { id: 'a', amount: 0 },
      { id: 'b', amount: 1000 },
    ];
    const result = simulateAllocation(50, tickets);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(50);
    expect(sumOf(result)).toBe(50);
  });

  it('rounding-remainder ties: constructs equal fractional parts so the ascending-id tie-break is the only thing deciding who gets the extra kobo', () => {
    // Three equal-amount rows splitting a fee that doesn't divide evenly by 3
    // produce identical fractional parts (1/3 each) -- the extra kobo must go
    // to the lowest id, deterministically, every time this is computed.
    const tickets = [
      { id: 'z-ticket', amount: 100 },
      { id: 'a-ticket', amount: 100 },
      { id: 'm-ticket', amount: 100 },
    ];
    const result = simulateAllocation(10, tickets); // 10/3 = 3.333... each, remainder 1
    expect(sumOf(result)).toBe(10);
    expect(result.get('a-ticket')).toBe(4); // lowest id (lexicographic) wins the tie
    expect(result.get('m-ticket')).toBe(3);
    expect(result.get('z-ticket')).toBe(3);
    // re-running the identical simulation is byte-for-byte identical (determinism)
    const rerun = simulateAllocation(10, tickets);
    expect([...rerun.entries()]).toEqual([...result.entries()]);
  });

  it('zero-fee / all-free orders: every row gets exactly 0 with no division performed', () => {
    const tickets = [
      { id: 'a', amount: 0 },
      { id: 'b', amount: 0 },
      { id: 'c', amount: 0 },
    ];
    const result = simulateAllocation(0, tickets);
    expect(sumOf(result)).toBe(0);
    for (const t of tickets) expect(result.get(t.id)).toBe(0);
  });

  it('repeated/idempotent calls: the SQL function itself (not this simulation) only ever targets rows WHERE platform_fee_kobo IS NULL, so a second call changes nothing -- asserted directly against the migration text, since idempotency is a property of the SQL\'s WHERE-clause scoping, not of this JS simulation', () => {
    const fn = allocateFn();
    // the early no-op guard: if no paid row in the order is still NULL, return immediately
    expect(fn).toMatch(/IF NOT EXISTS \([\s\S]*?platform_fee_kobo IS NULL\s*\n\s*\) THEN\s*\n\s*RETURN;/);
    // and the actual write path itself is scoped to NULL rows only, as a second layer of protection
    expect(fn).toMatch(/WHERE t\.payment_ref = p_payment_ref AND t\.payment_status = 'paid' AND t\.platform_fee_kobo IS NULL/);
  });

  it('simulation sanity check: running the same non-trivial scenario twice yields identical per-row results (the JS mirror is itself deterministic, matching what the SQL is designed to guarantee)', () => {
    const tickets = [
      { id: '11111111-0000-0000-0000-000000000001', amount: 1750 },
      { id: '11111111-0000-0000-0000-000000000002', amount: 2225 },
      { id: '11111111-0000-0000-0000-000000000003', amount: 975 },
    ];
    const first = simulateAllocation(237, tickets);
    const second = simulateAllocation(237, tickets);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(sumOf(first)).toBe(237);
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
