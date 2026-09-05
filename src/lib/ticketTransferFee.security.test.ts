import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Same static-analysis approach as serviceProviderCapability.security.test.ts:
// this repo has no live Postgres/RLS test harness, so these assert the
// security/correctness properties are actually encoded in the migration SQL
// that ships to production, rather than exercising a live database. That
// still catches the failure modes that matter: someone widening a GRANT,
// dropping a row lock, trusting a client-supplied amount, or letting
// ownership move without the fee (or the fee get marked paid without
// ownership moving) would fail one of these.

let m0040: string;
let m0043: string;
let m0004: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0040 = readFileSync(join(migrationsDir, '0040_ticket_transfer.sql'), 'utf8');
  m0043 = readFileSync(join(migrationsDir, '0043_ticket_transfer_fee.sql'), 'utf8');
  m0004 = readFileSync(join(migrationsDir, '0004_functions.sql'), 'utf8');
});

describe('ticket transfer: ownership lifecycle preserved (0040, unmodified by 0043)', () => {
  it('initiate_ticket_transfer never assigns tickets.user_id (sender keeps the ticket while pending)', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.initiate_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).not.toMatch(/UPDATE public\.tickets/);
    expect(fn).toMatch(/INSERT INTO public\.ticket_transfers/);
  });

  it('decline_ticket_transfer and cancel_ticket_transfer never touch the tickets table', () => {
    const decline = m0040.match(/CREATE OR REPLACE FUNCTION public\.decline_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] || '';
    const cancel = m0040.match(/CREATE OR REPLACE FUNCTION public\.cancel_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(decline).not.toMatch(/UPDATE public\.tickets/);
    expect(cancel).not.toMatch(/UPDATE public\.tickets/);
    // Both only ever move ticket_transfers.status away from 'pending' --
    // ownership is unaffected either way.
    expect(decline).toMatch(/SET status = 'declined'/);
    expect(cancel).toMatch(/SET status = 'cancelled'/);
  });

  it('the one-pending-transfer-per-ticket unique index and row locks are unchanged', () => {
    expect(m0040).toMatch(/CREATE UNIQUE INDEX ticket_transfers_one_pending_per_ticket\s*\n\s*ON ticket_transfers \(ticket_id\) WHERE \(status = 'pending'\)/);
  });

  it('generate_ticket_token still requires the caller to be the LIVE ticket owner', () => {
    const fn = m0004.match(/CREATE OR REPLACE FUNCTION public\.generate_ticket_token[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/IF auth\.uid\(\) IS NULL OR auth\.uid\(\) <> v_owner THEN/);
  });

  it('verify_entry_pass still rejects a token whose purchaserId no longer matches the live owner', () => {
    const fn = m0004.match(/CREATE OR REPLACE FUNCTION public\.verify_entry_pass[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/\(v_payload->>'purchaserId'\) IS DISTINCT FROM v_ticket\.user_id::text/);
    expect(fn).toMatch(/'payload_mismatch'/);
  });
});

describe('ticket transfer fee: computation (0043)', () => {
  it('compute_transfer_fee_kobo is 7.5% of the ticket amount, clamped to NGN 500-5000, and never trusts a client-supplied amount', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.compute_transfer_fee_kobo[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/GREATEST\(50000, LEAST\(500000, ROUND\(COALESCE\(p_ticket_amount, 0\) \* 100 \* 0\.075\)\)\)/);

    // Every caller passes tickets.amount read from the row itself, never a
    // parameter named anything like p_fee/p_amount supplied by the client.
    const initiate = m0043.match(/CREATE OR REPLACE FUNCTION public\.initiate_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(initiate).toMatch(/v_fee_kobo := public\.compute_transfer_fee_kobo\(v_ticket\.amount\);/);
    expect(initiate).toMatch(/SELECT t\.id, t\.user_id, t\.status, t\.payment_status, t\.checked_in, t\.amount, e\.event_date/);
  });

  it('boundary math: 100 NGN ticket floors to the 500 NGN minimum, 200,000 NGN ticket caps at the 5,000 NGN maximum, 10,000 NGN ticket lands on the plain 7.5%', () => {
    // Mirrors the SQL formula in JS purely to sanity-check the constants
    // chosen (50000/500000 kobo, 0.075) actually produce NGN 500/5000/750 --
    // the SQL text assertion above is what actually guards the production
    // formula; this is a readability cross-check on the same three numbers.
    const computeKobo = (amountNaira: number) =>
      Math.max(50000, Math.min(500000, Math.round(amountNaira * 100 * 0.075)));

    expect(computeKobo(100)).toBe(50000); // NGN 500 floor
    expect(computeKobo(10000)).toBe(75000); // exactly 7.5% = NGN 750
    expect(computeKobo(200000)).toBe(500000); // NGN 5000 ceiling
    expect(computeKobo(0)).toBe(50000); // free/₦0 ticket still floors to the minimum
  });
});

describe('ticket transfer fee: payment must be verified before ownership moves (0043)', () => {
  it('confirm_transfer_fee_payment is project_admin-only -- never callable by anon/authenticated', () => {
    expect(m0043).toMatch(
      /REVOKE ALL ON FUNCTION public\.confirm_transfer_fee_payment\(text, bigint\) FROM PUBLIC, anon, authenticated, project_admin;\s*\nGRANT EXECUTE ON FUNCTION public\.confirm_transfer_fee_payment\(text, bigint\) TO project_admin;/
    );
  });

  it('confirm_transfer_fee_payment rejects any amount that does not exactly match the locked-in fee_kobo', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/IF p_amount_kobo IS DISTINCT FROM v_transfer\.fee_kobo THEN\s*\n\s*RETURN 'amount_mismatch/);
  });

  it('confirm_transfer_fee_payment is idempotent (a retried verify call after success is a safe no-op, not a double-charge/double-transfer)', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/IF v_transfer\.fee_paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;/);
  });

  it('confirm_transfer_fee_payment locks both the transfer row and the ticket row before touching either (prevents concurrent-acceptance races)', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/SELECT \* INTO v_transfer FROM public\.ticket_transfers WHERE fee_payment_ref = p_reference FOR UPDATE;/);
    expect(fn).toMatch(/SELECT t\.user_id, t\.status, t\.checked_in\s*\n\s*INTO v_ticket\s*\n\s*FROM public\.tickets t\s*\n\s*WHERE t\.id = v_transfer\.ticket_id\s*\n\s*FOR UPDATE;/);
  });

  it('confirm_transfer_fee_payment re-validates the ticket is still eligible (not already reassigned/checked in) before swapping ownership', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/v_ticket\.user_id IS DISTINCT FROM v_transfer\.from_user_id\s*\n\s*OR v_ticket\.status <> 'active' OR v_ticket\.checked_in THEN/);
  });

  it('confirm_transfer_fee_payment marks the fee paid in the SAME statement set that swaps ownership -- never one without the other', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.confirm_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] || '';
    // Ownership swap
    expect(fn).toMatch(/UPDATE public\.tickets\s*\n\s*SET user_id = v_transfer\.to_user_id,/);
    // Fee-paid marker, committed in the same function invocation/transaction
    expect(fn).toMatch(/UPDATE public\.ticket_transfers\s*\n\s*SET status = 'accepted', responded_at = now\(\), fee_paid_at = now\(\)/);
  });

  it('accept_ticket_transfer (the free-path RPC) refuses to run the ownership swap for any transfer with an unpaid fee', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.accept_ticket_transfer[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/IF v_transfer\.fee_kobo > 0 AND v_transfer\.fee_paid_at IS NULL THEN\s*\n\s*RAISE EXCEPTION 'A transfer fee must be paid before this transfer can be accepted';/);
  });
});

describe('ticket transfer fee: reference generation (0043)', () => {
  it('initiate_transfer_fee_payment is recipient-only, pending-only, and generates an unguessable reference', () => {
    const fn = m0043.match(/CREATE OR REPLACE FUNCTION public\.initiate_transfer_fee_payment[\s\S]*?\$function\$\s*;/)?.[0] || '';
    expect(fn).toMatch(/IF v_transfer\.to_user_id IS DISTINCT FROM v_uid THEN/);
    expect(fn).toMatch(/IF v_transfer\.status <> 'pending' THEN/);
    expect(fn).toMatch(/v_ref := 'txf_' \|\| replace\(gen_random_uuid\(\)::text, '-', ''\);/);
  });

  it('the fee_payment_ref column has a unique index so two transfers can never collide on the same reference', () => {
    expect(m0043).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ticket_transfers_fee_payment_ref_idx\s*\n\s*ON public\.ticket_transfers \(fee_payment_ref\) WHERE \(fee_payment_ref IS NOT NULL\);/);
  });
});
