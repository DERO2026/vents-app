import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0075_wallet_refund_fee_ledger_and_error_hardening.sql
// -- a /code-review pass on the wallet audit flagged two findings, fixed
// here: (1) wallet-ticket refunds silently absorbed the platform's 5% fee
// with no ledger record of it, and (2) confirm_ticket_payment_via_wallet
// swallowed every exception from finalize_pending_purchase, not just the
// one documented benign case.

let m0075: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0075 = readFileSync(join(dir, '0075_wallet_refund_fee_ledger_and_error_hardening.sql'), 'utf8');
});

function refundTicketFn(): string {
  return m0075.match(/CREATE OR REPLACE FUNCTION public\.refund_ticket\(p_ticket_id uuid, p_reason text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

function walletConfirmFn(): string {
  return m0075.match(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment_via_wallet\(p_payment_ref text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
}

describe('Wallet ticket refund: platform fee is credited to the buyer but recorded, never silently dropped', () => {
  it('computes the platform fee as the fee-inclusive refund minus the organizer subtotal', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/v_platform_fee_kobo := GREATEST\(0, v_refund_kobo - floor\(v_ticket\.amount \* 100\)::bigint\);/);
  });

  it('still credits the buyer the FULL fee-inclusive amount (unchanged business rule: full refund to the customer)', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/UPDATE public\.user_wallets\s*\n\s*SET balance_kobo = balance_kobo \+ v_refund_kobo, updated_at = now\(\)/);
  });

  it('still claws back only the subtotal from the organizer, never the fee (organizer never received the fee to begin with)', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/v_owed_kobo := floor\(v_ticket\.amount \* 100\)::bigint;/);
    expect(fn).not.toMatch(/v_owed_kobo := v_refund_kobo/);
  });

  it('records the platform fee absorption in the refund transaction metadata, not as a balance change', () => {
    const fn = refundTicketFn();
    const insertBlock = fn.match(/INSERT INTO public\.user_wallet_transactions[\s\S]*?RETURNING id INTO v_wallet_refund_tx_id;/)?.[0] ?? '';
    expect(insertBlock).toMatch(/'platform_fee_absorbed_kobo', v_platform_fee_kobo/);
  });

  it('logs an explicit, queryable admin_logs entry for the absorbed fee, only when a fee was actually absorbed', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/IF v_platform_fee_kobo > 0 THEN\s*\n\s*INSERT INTO public\.admin_logs[\s\S]*?'refund_platform_fee_absorbed'/);
  });

  it('is idempotent: the unique partial index on (type=refund, reference_id) still guards a second call', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'refund' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(fn).toMatch(/IF v_wallet_refund_tx_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('status', 'already_refunded', 'ticket_id', v_ticket\.id\);/);
  });

  it('a free ticket (amount <= 0) is unaffected -- no platform fee variable touched on that path', () => {
    const fn = refundTicketFn();
    const freeTicketBlock = fn.match(/IF v_ticket\.amount <= 0 OR v_refund_kobo <= 0 THEN[\s\S]*?RETURN jsonb_build_object\('status', 'refunded', 'ticket_id', v_ticket\.id, 'amount_kobo', 0\);\s*\n\s*END IF;/)?.[0] ?? '';
    expect(freeTicketBlock).not.toMatch(/v_platform_fee_kobo/);
  });

  it('the Paystack-paid refund branch is completely untouched by this migration', () => {
    const fn = refundTicketFn();
    expect(fn).toMatch(/UPDATE public\.tickets\s*\n\s*SET payment_status = 'refund_pending', status = 'cancelled',\s*\n\s*refund_reason = p_reason, refund_initiated_by = auth\.uid\(\)\s*\n\s*WHERE id = v_ticket\.id;\s*\n\s*\n\s*INSERT INTO public\.admin_logs \(admin_id, action, target_user_id, details, actor_role\)\s*\n\s*VALUES \(\s*\n\s*auth\.uid\(\), 'refund_ticket_initiated'/);
  });
});

describe('confirm_ticket_payment_via_wallet: only the documented benign exception is swallowed', () => {
  it('re-raises anything from finalize_pending_purchase other than "not found", after logging it', () => {
    const fn = walletConfirmFn();
    expect(fn).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n\s*IF SQLERRM NOT LIKE 'Pending purchase not found for reference%' THEN\s*\n\s*RAISE WARNING[\s\S]*?RAISE;\s*\n\s*END IF;/);
  });

  it('still swallows exactly the documented "no pending_purchases row" case', () => {
    const fn = walletConfirmFn();
    expect(fn).toMatch(/'Pending purchase not found for reference%'/);
  });

  it('every other line of the function (auth check, ownership check, idempotent debit, organizer credit) is unchanged from 0066', () => {
    const fn = walletConfirmFn();
    expect(fn).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
    expect(fn).toMatch(/IF v_user_id IS DISTINCT FROM v_uid THEN\s*\n\s*RAISE EXCEPTION 'Not authorized for this payment reference';/);
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'spend' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(fn).toMatch(/PERFORM public\.credit_organizer_wallet\(/);
  });

  it('still authenticated-callable, self-scoped -- grants unchanged from 0066', () => {
    expect(m0075).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_ticket_payment_via_wallet\(text\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment_via_wallet\(text\) TO authenticated;/);
  });
});
