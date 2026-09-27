import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0108_block_cancel_of_completed_service_booking.sql.
//
// Master security audit (MEDIUM #5): cancel_service_booking() never checked
// the booking's own `status` before cancelling/refunding it -- only
// payment_status was gated. That let a provider (or an admin) cancel and
// fully refund a booking already marked 'completed', i.e. after the service
// was delivered and possibly already reviewed (migration 0099 requires
// status='completed' before a review can be left). Same issue class as
// refund-after-check-in for tickets, which refund_ticket already blocks.
//
// Fix: add a guard -- IF v_booking.status = 'completed' THEN RAISE
// EXCEPTION -- placed right after the provider/admin authorization check
// and before any payment_status branching or refund logic runs.
//
// Behavioral proof was run live, in isolated rolled-back transactions with
// synthetic fixtures and zero residue, against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX: a provider successfully cancelled and refunded (to wallet)
//     a booking with status='completed', payment_status='paid'.
//   - POST-FIX: the identical call now raises "A completed booking cannot
//     be cancelled or refunded" and the booking's status/payment_status
//     are unchanged.
//   - POST-FIX: a legitimate cancellation of a still-'confirmed'
//     (not completed) paid booking still succeeds and refunds correctly.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0108_block_cancel_of_completed_service_booking.sql'), 'utf8');
});

function body(): string {
  return migration.match(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking\([\s\S]*?\$function\$;/)?.[0] ?? '';
}

describe('Blocks cancel_service_booking() on an already-completed booking', () => {
  it('redefines cancel_service_booking (not a new function)', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.cancel_service_booking\(/);
  });

  it('raises before any payment_status branching if the booking is completed', () => {
    const fn = body();
    const guardIdx = fn.indexOf("IF v_booking.status = 'completed' THEN");
    const authIdx = fn.indexOf('Only the service provider or an admin can cancel this booking');
    const paidBranchIdx = fn.indexOf("IF v_booking.payment_status = 'refunded' THEN");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(authIdx);
    expect(paidBranchIdx).toBeGreaterThan(guardIdx);
    expect(fn).toMatch(/RAISE EXCEPTION 'A completed booking cannot be cancelled or refunded';/);
  });

  it('leaves auth, refund-reason, payment_status state machine, and wallet double-credit guard unchanged', () => {
    const fn = body();
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL THEN/);
    expect(fn).toMatch(/A refund reason is required/);
    expect(fn).toMatch(/Only the service provider or an admin can cancel this booking/);
    expect(fn).toMatch(/already_refunded/);
    expect(fn).toMatch(/refund_pending/);
    expect(fn).toMatch(/Only paid bookings can be refunded/);
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'refund' AND reference_id IS NOT NULL\) DO NOTHING/);
  });
});
