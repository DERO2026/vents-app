import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for VENTS Wallet payments -- Tickets + Services
// (0066_wallet_payments.sql). Verifies the Wallet-pay confirm functions
// never grant a ticket/booking without a successful atomic wallet debit
// (and vice versa), never allow a negative balance, are idempotent under
// concurrency, and leave the existing Paystack confirm functions'
// behavior unchanged apart from the added payment_method write.

let m0066: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0066 = readFileSync(join(dir, '0066_wallet_payments.sql'), 'utf8');
});

describe('payment_method: reliable server-side recording, no frontend-state inference', () => {
  it('tickets.payment_method and service_bookings.payment_method are added, constrained to paystack/wallet only', () => {
    expect(m0066).toMatch(/ALTER TABLE public\.tickets\s*\n\s*ADD COLUMN IF NOT EXISTS payment_method text\s*\n\s*CONSTRAINT tickets_payment_method_check CHECK \(payment_method IN \('paystack', 'wallet'\)\);/);
    expect(m0066).toMatch(/ALTER TABLE public\.service_bookings\s*\n\s*ADD COLUMN IF NOT EXISTS payment_method text\s*\n\s*CONSTRAINT service_bookings_payment_method_check CHECK \(payment_method IN \('paystack', 'wallet'\)\);/);
  });

  it('the existing Paystack confirm functions now record payment_method = paystack on the same UPDATE that flips payment_status', () => {
    const ticketFn = m0066.match(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment\(p_reference text, p_amount_kobo bigint\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(ticketFn).toMatch(/SET payment_status = 'paid', payment_method = 'paystack'/);

    const bookingFn = m0066.match(/CREATE OR REPLACE FUNCTION public\.confirm_service_booking_payment\(p_reference text, p_amount_kobo bigint\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(bookingFn).toMatch(/SET payment_status = 'paid', status = 'confirmed', payment_method = 'paystack'/);
  });

  it('the wallet confirm functions record payment_method = wallet, never inferred from any caller-supplied field', () => {
    const ticketWalletFn = m0066.match(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment_via_wallet\(p_payment_ref text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(ticketWalletFn).toMatch(/SET payment_status = 'paid', payment_method = 'wallet'/);

    const bookingWalletFn = m0066.match(/CREATE OR REPLACE FUNCTION public\.confirm_service_booking_payment_via_wallet\(p_reference text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(bookingWalletFn).toMatch(/SET payment_status = 'paid', status = 'confirmed', payment_method = 'wallet'/);
  });
});

describe('Wallet ticket payment: atomic debit + grant, insufficient balance, idempotency', () => {
  function ticketWalletFn(): string {
    return m0066.match(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment_via_wallet\(p_payment_ref text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
  }

  it('is authenticated-callable and self-scoped (auth.uid()), not project_admin-only like the Paystack confirm functions', () => {
    const fn = ticketWalletFn();
    expect(fn).toMatch(/v_uid\s+uuid := auth\.uid\(\);/);
    expect(fn).toMatch(/IF v_uid IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';/);
    expect(m0066).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_ticket_payment_via_wallet\(text\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.confirm_ticket_payment_via_wallet\(text\) TO authenticated;/);
  });

  it('rejects a caller asking about a payment_ref that is not their own (no Someone-Else-Pays via Wallet in this pass)', () => {
    const fn = ticketWalletFn();
    expect(fn).toMatch(/IF v_user_id IS DISTINCT FROM v_uid THEN\s*\n\s*RAISE EXCEPTION 'Not authorized for this payment reference';/);
  });

  it('locks the ticket rows and the wallet row before checking/moving anything', () => {
    const fn = ticketWalletFn();
    expect(fn).toMatch(/PERFORM 1 FROM public\.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;/);
    expect(fn).toMatch(/FROM public\.user_wallets WHERE user_id = v_uid FOR UPDATE;/);
  });

  it('re-derives the server-authoritative total independently -- never trusts a client-supplied amount', () => {
    const fn = ticketWalletFn();
    expect(fn).toMatch(/v_expected_kobo := round\(v_total_amount \* \(1\.05 - COALESCE\(v_discount_pct, 0\) \/ 100\) \* 100\)::bigint;/);
    // No parameter carries an amount at all -- the function signature is
    // p_payment_ref only, unlike the Paystack confirm functions which take
    // p_amount_kobo from Paystack's own verified transaction.
    expect(m0066).toMatch(/CREATE OR REPLACE FUNCTION public\.confirm_ticket_payment_via_wallet\(p_payment_ref text\)/);
  });

  it('rejects with insufficient_balance before any debit or grant when the wallet cannot cover the total', () => {
    const fn = ticketWalletFn();
    const balanceCheckIdx = fn.indexOf("RETURN 'insufficient_balance");
    const debitIdx = fn.indexOf('SET balance_kobo = balance_kobo - v_expected_kobo');
    const grantIdx = fn.indexOf("SET payment_status = 'paid', payment_method = 'wallet'");
    expect(balanceCheckIdx).toBeGreaterThan(-1);
    expect(debitIdx).toBeGreaterThan(balanceCheckIdx);
    expect(grantIdx).toBeGreaterThan(balanceCheckIdx);
  });

  it('debits the wallet strictly before granting the ticket, both inside the same transaction/function', () => {
    const fn = ticketWalletFn();
    const debitIdx = fn.indexOf('SET balance_kobo = balance_kobo - v_expected_kobo');
    const grantIdx = fn.indexOf("SET payment_status = 'paid', payment_method = 'wallet'");
    expect(debitIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(debitIdx);
  });

  it('is idempotent via the spend ledger unique index guarded with ON CONFLICT DO NOTHING, mirroring the deposit pattern', () => {
    expect(m0066).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_spend_ref_idx\s*\n\s*ON public\.user_wallet_transactions \(reference_id\)\s*\n\s*WHERE \(type = 'spend' AND reference_id IS NOT NULL\);/);
    const fn = ticketWalletFn();
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'spend' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(fn).toMatch(/IF v_tx_id IS NULL THEN\s*\n\s*RETURN 'already_paid';/);
  });

  it('a fully-paid payment_ref short-circuits to already_paid before ever touching the wallet', () => {
    const fn = ticketWalletFn();
    const alreadyPaidIdx = fn.indexOf("IF v_paid_count = v_ticket_count THEN");
    const walletLockIdx = fn.indexOf('FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;');
    expect(alreadyPaidIdx).toBeGreaterThan(-1);
    expect(walletLockIdx).toBeGreaterThan(alreadyPaidIdx);
  });

  it('credits the organizer earnings wallet exactly as the existing Paystack ticket flow does, via the same shared function', () => {
    const fn = ticketWalletFn();
    expect(fn).toMatch(/PERFORM public\.credit_organizer_wallet\(/);
  });

  it('never touches organizer_wallets or vents_wallets architecture directly -- only calls the existing shared credit functions', () => {
    expect(m0066).not.toMatch(/ALTER TABLE public\.organizer_wallets/);
    expect(m0066).not.toMatch(/ALTER TABLE public\.vents_wallets/);
    expect(m0066).not.toMatch(/CREATE TABLE[^;]*organizer_wallets/);
    expect(m0066).not.toMatch(/CREATE TABLE[^;]*vents_wallets/);
  });
});

describe('Wallet service booking payment: atomic debit + confirm, insufficient balance, idempotency', () => {
  function bookingWalletFn(): string {
    return m0066.match(/CREATE OR REPLACE FUNCTION public\.confirm_service_booking_payment_via_wallet\(p_reference text\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
  }

  it('is authenticated-callable and self-scoped, rejects a caller who is not the booking customer', () => {
    const fn = bookingWalletFn();
    expect(fn).toMatch(/v_uid uuid := auth\.uid\(\);/);
    expect(fn).toMatch(/IF v_booking\.customer_id IS DISTINCT FROM v_uid THEN\s*\n\s*RAISE EXCEPTION 'Not authorized for this booking';/);
    expect(m0066).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_service_booking_payment_via_wallet\(text\) FROM PUBLIC, anon, authenticated, project_admin;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.confirm_service_booking_payment_via_wallet\(text\) TO authenticated;/);
  });

  it('locks the booking row and the wallet row before checking/moving anything', () => {
    const fn = bookingWalletFn();
    expect(fn).toMatch(/FROM public\.service_bookings WHERE payment_ref = p_reference FOR UPDATE;/);
    expect(fn).toMatch(/FROM public\.user_wallets WHERE user_id = v_uid FOR UPDATE;/);
  });

  it('uses the existing server-calculated total_kobo (subtotal + 5% fee) -- never a client-supplied amount', () => {
    const fn = bookingWalletFn();
    expect(fn).toMatch(/IF v_wallet_balance < v_booking\.total_kobo THEN/);
    expect(fn).not.toMatch(/p_amount_kobo/);
  });

  it('rejects with insufficient_balance strictly before any debit or confirm', () => {
    const fn = bookingWalletFn();
    const balanceCheckIdx = fn.indexOf("RETURN 'insufficient_balance");
    const debitIdx = fn.indexOf('SET balance_kobo = balance_kobo - v_booking.total_kobo');
    const confirmIdx = fn.indexOf("SET payment_status = 'paid', status = 'confirmed', payment_method = 'wallet'");
    expect(balanceCheckIdx).toBeGreaterThan(-1);
    expect(debitIdx).toBeGreaterThan(balanceCheckIdx);
    expect(confirmIdx).toBeGreaterThan(balanceCheckIdx);
  });

  it('debits the wallet strictly before confirming the booking', () => {
    const fn = bookingWalletFn();
    const debitIdx = fn.indexOf('SET balance_kobo = balance_kobo - v_booking.total_kobo');
    const confirmIdx = fn.indexOf("SET payment_status = 'paid', status = 'confirmed', payment_method = 'wallet'");
    expect(debitIdx).toBeGreaterThan(-1);
    expect(confirmIdx).toBeGreaterThan(debitIdx);
  });

  it('is idempotent via the same spend ledger unique index as the ticket flow', () => {
    const fn = bookingWalletFn();
    expect(fn).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'spend' AND reference_id IS NOT NULL\) DO NOTHING/);
    expect(fn).toMatch(/IF v_tx_id IS NULL THEN\s*\n\s*RETURN 'already_paid';/);
  });

  it('an already-paid booking short-circuits before ever touching the wallet', () => {
    const fn = bookingWalletFn();
    const alreadyPaidIdx = fn.indexOf("IF v_booking.payment_status = 'paid' THEN");
    const walletLockIdx = fn.indexOf('FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;');
    expect(alreadyPaidIdx).toBeGreaterThan(-1);
    expect(walletLockIdx).toBeGreaterThan(alreadyPaidIdx);
  });

  it('credits the provider earnings wallet with subtotal_kobo (fee stays with VENTS), via the same existing shared function', () => {
    const fn = bookingWalletFn();
    expect(fn).toMatch(/PERFORM public\.credit_provider_wallet_for_booking\(v_provider_user_id, v_booking\.subtotal_kobo, v_booking\.id/);
  });
});

describe('Balance safety: negative balance impossible regardless of any logic bug here', () => {
  it('neither wallet-pay function writes balance_kobo without going through the existing DB-level non-negative CHECK from 0065', () => {
    // Structural guarantee lives in user_wallets_balance_non_negative
    // (0065_user_wallets.sql) -- this migration does not redefine or drop
    // that constraint, so even a hypothetical bug in the balance check
    // above cannot leave a negative balance; the UPDATE itself would abort.
    expect(m0066).not.toMatch(/DROP CONSTRAINT[^;]*user_wallets_balance_non_negative/);
    expect(m0066).not.toMatch(/ALTER TABLE public\.user_wallets(?!\s+ADD)/);
  });
});

describe('No second refund system created; existing Paystack path left otherwise unchanged', () => {
  it('this migration does not touch refund_ticket, attach_transfer_fee_refund_id, or any Paystack refund call', () => {
    expect(m0066).not.toMatch(/CREATE OR REPLACE FUNCTION public\.refund_ticket/);
    expect(m0066).not.toMatch(/paystack\.co\/refund/);
  });

  it('create_pending_purchase, finalize_pending_purchase, and create_service_booking are not redefined here -- only called into', () => {
    expect(m0066).not.toMatch(/CREATE OR REPLACE FUNCTION public\.create_pending_purchase/);
    expect(m0066).not.toMatch(/CREATE OR REPLACE FUNCTION public\.finalize_pending_purchase/);
    expect(m0066).not.toMatch(/CREATE OR REPLACE FUNCTION public\.create_service_booking/);
    expect(m0066).toMatch(/PERFORM public\.finalize_pending_purchase\(p_payment_ref\);/);
  });
});
