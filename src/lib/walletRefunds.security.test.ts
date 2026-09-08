import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for VENTS Wallet refunds (0067_wallet_refunds.sql).
//
// Scope note: this migration implements TICKET wallet refunds only. The
// audit that preceded this migration (see its own header comment) found
// no existing Service-booking cancellation/refund RPC anywhere in this
// schema to modify -- building one from scratch was out of scope for
// "wallet refunds" and would itself be a new parallel system, so it was
// deliberately not attempted. These tests verify that finding stays true
// and that only the real, existing refund_ticket path was touched.

let m0067: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0067 = readFileSync(join(dir, '0067_wallet_refunds.sql'), 'utf8');
});

function refundTicketFn(): string {
  return m0067.match(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(p_ticket_id uuid, p_reason text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

describe('Modifies the actual existing refund_ticket path, not a parallel system', () => {
  it('redefines refund_ticket (the real, already-granted entry point) rather than introducing a new refund function name', () => {
    expect(m0067).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(p_ticket_id uuid, p_reason text\)/);
    expect(m0067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket_wallet/);
    expect(m0067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.wallet_refund_ticket/);
  });

  it('does not touch finalize_ticket_refund, fail_ticket_refund, or api/wallet/refund-ticket.ts\'s Paystack call -- the existing async Paystack path is left alone', () => {
    expect(m0067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.finalize_ticket_refund/);
    expect(m0067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fail_ticket_refund/);
    expect(m0067).not.toMatch(/paystack\.co\/refund/);
  });

  it('does not implement any Service-booking cancel/refund function -- the audited finding was that none exists yet', () => {
    expect(m0067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.\w*service_booking\w*(cancel|refund)\w*/i);
    expect(m0067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.\w*(cancel|refund)\w*service_booking\w*/i);
  });

  it('preserves the existing free-ticket instant-refund branch and the existing Paystack refund_pending branch unchanged', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/IF v_ticket\.amount <= 0 OR v_refund_kobo <= 0 THEN/);
    expect(fn).toMatch(/SET payment_status = 'refund_pending', status = 'cancelled',/);
  });
});

describe('Wallet ticket refund: correct amount, correct recipient, atomic with the ticket state change', () => {
  it('only applies to payment_method = wallet -- Paystack/legacy NULL tickets fall through to the unchanged refund_pending branch', () => {
    const fn = refundTicketFn();
    const walletBranchIdx = fn.indexOf("IF v_ticket.payment_method = 'wallet' THEN");
    const paystackBranchIdx = fn.indexOf("SET payment_status = 'refund_pending', status = 'cancelled',");
    expect(walletBranchIdx).toBeGreaterThan(-1);
    expect(paystackBranchIdx).toBeGreaterThan(walletBranchIdx);
  });

  it('the refund amount is the same server-derived formula used everywhere else in this function -- never a client-supplied amount', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/v_refund_kobo := round\(v_ticket\.amount \* \(1\.05 - COALESCE\(v_ticket\.discount_percentage, 0\) \/ 100\) \* 100\)::bigint;/);
    // refund_ticket's only inputs are p_ticket_id and p_reason -- no amount
    // parameter exists anywhere in this function's signature.
    expect(m0067).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(p_ticket_id uuid, p_reason text\)/);
  });

  it('always credits v_ticket.user_id (the ticket\'s own holder) -- never the caller (auth.uid()) or any other id', () => {
    const fn = refundTicketFn();
    const walletBranch = fn.slice(fn.indexOf("IF v_ticket.payment_method = 'wallet' THEN"), fn.indexOf('-- Paystack-paid'));
    expect(walletBranch).toMatch(/INSERT INTO public\.user_wallets \(user_id\) VALUES \(v_ticket\.user_id\)/);
    expect(walletBranch).toMatch(/FROM public\.user_wallets WHERE user_id = v_ticket\.user_id FOR UPDATE;/);
    expect(walletBranch).toMatch(/SET balance_kobo = balance_kobo \+ v_refund_kobo, updated_at = now\(\)\s*\n\s*WHERE user_id = v_ticket\.user_id;/);
    // The caller is authorized to REFUND (organizer/admin check earlier in
    // the function) but is never the one credited.
    expect(walletBranch).not.toMatch(/balance_kobo \+ v_refund_kobo[\s\S]*WHERE user_id = auth\.uid\(\)/);
  });

  it('locks the wallet row before crediting it', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/FROM public\.user_wallets WHERE user_id = v_ticket\.user_id FOR UPDATE;/);
  });

  it('is idempotent via a unique partial index on reference_id for refunds, guarded with ON CONFLICT DO NOTHING', () => {
    expect(m0067).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_refund_ref_idx\s*\n\s*ON public\.user_wallet_transactions \(reference_id\)\s*\n\s*WHERE \(type = 'refund' AND reference_id IS NOT NULL\);/);
    const fn = refundTicketFn();
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'refund' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(fn).toMatch(/IF v_wallet_refund_tx_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('status', 'already_refunded'/);
  });

  it('the top-of-function already_refunded check (under the ticket\'s own row lock) is the primary guard against a duplicate/concurrent refund', () => {
    const fn = refundTicketFn();
    const alreadyRefundedIdx = fn.indexOf("IF v_ticket.payment_status = 'refunded' THEN");
    const forUpdateIdx = fn.indexOf('FOR UPDATE OF t;');
    const walletBranchIdx = fn.indexOf("IF v_ticket.payment_method = 'wallet' THEN");
    expect(forUpdateIdx).toBeGreaterThan(-1);
    expect(alreadyRefundedIdx).toBeGreaterThan(forUpdateIdx);
    expect(walletBranchIdx).toBeGreaterThan(alreadyRefundedIdx);
  });

  it('credits the wallet strictly before flipping the ticket to refunded, both inside the same function/transaction', () => {
    const fn = refundTicketFn();
    const creditIdx = fn.indexOf('SET balance_kobo = balance_kobo + v_refund_kobo');
    const ticketFlipIdx = fn.lastIndexOf("SET payment_status = 'refunded', status = 'cancelled',");
    expect(creditIdx).toBeGreaterThan(-1);
    expect(ticketFlipIdx).toBeGreaterThan(creditIdx);
  });

  it('never calls Paystack for a wallet refund', () => {
    const fn = refundTicketFn();
    const walletBranch = fn.slice(fn.indexOf("IF v_ticket.payment_method = 'wallet' THEN"), fn.indexOf('-- Paystack-paid'));
    expect(walletBranch).not.toMatch(/paystack/i);
  });
});

describe('Organizer earnings reversed identically regardless of payment method', () => {
  it('reverses the same amount (floor(amount * 100)) via the same clamped-under-lock debit pattern as finalize_ticket_refund', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/v_owed_kobo := floor\(v_ticket\.amount \* 100\)::bigint;/);
    expect(fn).toMatch(/FROM public\.organizer_wallets\s*\n\s*WHERE organizer_id = v_ticket\.organizer_id\s*\n\s*FOR UPDATE;/);
    expect(fn).toMatch(/v_actual_debit := LEAST\(COALESCE\(v_wallet_bal, 0\), v_owed_kobo\);/);
  });

  it('logs a shortfall to admin_logs when the organizer wallet cannot cover the full owed amount, same as the Paystack path', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/IF v_actual_debit < v_owed_kobo THEN\s*\n\s*INSERT INTO public\.admin_logs \(admin_id, action, target_user_id, details, actor_role\)\s*\n\s*VALUES\s*\(\s*\n\s*auth\.uid\(\), 'refund_wallet_shortfall'/);
  });

  it('does not touch VENTS Cents (vc_transactions) at all', () => {
    expect(m0067).not.toMatch(/vc_transactions/);
  });
});
