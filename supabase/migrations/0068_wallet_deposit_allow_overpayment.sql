-- Real bug found via a live Preview test deposit: confirm_wallet_deposit
-- required Paystack's verified amount to match the server-recorded intended
-- deposit (wallet_deposit_attempts.amount_kobo) EXACTLY. Same root cause
-- already fixed for tickets/service bookings in
-- migrations/20260806100000_fix-payment-amount-check-allow-overpayment.sql
-- and mirrored in confirm_ticket_payment/confirm_service_booking_payment
-- (both redefined in 0066_wallet_payments.sql to use `<` instead of
-- `IS DISTINCT FROM`): this Paystack account is configured to pass its own
-- per-channel transaction fee on to the customer, on top of the amount this
-- app requests -- a Paystack-dashboard setting, not something this app's
-- code controls or can predict. A real ₦1,000 deposit came back from
-- Paystack's verify as ₦1,015.23 actually charged -- the customer WAS
-- charged correctly, the deposit just never credited.
--
-- Fix, deliberately different in shape from the ticket/booking fix because
-- a wallet deposit has no separate "buyer fee" concept to absorb the
-- difference into: accept any Paystack-verified amount >= the intended
-- deposit (still rejects genuine underpayment), but credit the wallet with
-- exactly the intended amount (v_attempt.amount_kobo) rather than whatever
-- Paystack verified (p_amount_kobo) -- so Paystack's own processing fee is
-- never credited to the user's VENTS Wallet balance, and VENTS's 5% ticket/
-- booking fee is never introduced here either. p_amount_kobo is still the
-- value logged/reconciled against for idempotency and audit purposes.
CREATE OR REPLACE FUNCTION public.confirm_wallet_deposit(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_attempt record;
  v_tx_id   uuid;
BEGIN
  SELECT * INTO v_attempt FROM public.wallet_deposit_attempts WHERE reference = p_reference FOR UPDATE;
  IF v_attempt.reference IS NULL THEN RETURN 'not_found'; END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN RETURN 'invalid_amount'; END IF;

  IF p_amount_kobo < v_attempt.amount_kobo THEN
    RETURN 'amount_mismatch:' || v_attempt.amount_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  -- Credit exactly the intended deposit amount, never Paystack's
  -- fee-inflated verified amount -- see header comment above.
  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
  VALUES (v_attempt.user_id, 'deposit', v_attempt.amount_kobo, 'Wallet top-up', p_reference,
          jsonb_build_object('paystack_reference', p_reference, 'paystack_verified_amount_kobo', p_amount_kobo))
  ON CONFLICT (reference_id) WHERE (type = 'deposit' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_credited';
  END IF;

  INSERT INTO public.user_wallets (user_id, balance_kobo)
  VALUES (v_attempt.user_id, v_attempt.amount_kobo)
  ON CONFLICT (user_id) DO UPDATE
    SET balance_kobo = public.user_wallets.balance_kobo + v_attempt.amount_kobo, updated_at = now();

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_wallet_deposit(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_deposit(text, bigint) TO project_admin;
