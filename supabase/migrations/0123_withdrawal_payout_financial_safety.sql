-- Financial safety audit: withdrawal/payout system.
--
-- FINDING 1 (CRITICAL) -- credit_provider_wallet_for_booking (0054) was
-- GRANTed EXECUTE to `authenticated` with zero internal verification: no
-- auth check, no confirmation the booking exists/is paid/belongs to the
-- named provider. Every real call site (0054, 0061, 0066 x2) invokes it
-- only via `PERFORM public.credit_provider_wallet_for_booking(...)` from
-- inside another SECURITY DEFINER function's body -- a nested call like
-- that runs as the *calling function's owner* (postgres), never as the
-- original client role, so the `authenticated` grant was never needed for
-- any real code path. Left in place, it is a direct, unauthenticated
-- money-printing primitive: any signed-in user could call
-- credit_provider_wallet_for_booking(<any provider's user id>, <any
-- amount>, <a fresh random uuid>, 'x') over the normal PostgREST RPC
-- surface and have arbitrary funds credited to any organizer_wallets row,
-- withdrawable to a real bank account. Fixed two ways: (a) revoke the
-- `authenticated` grant (0110 already documented this function as one of
-- the "every legitimate write already goes through a SECURITY DEFINER
-- function" cases -- it just missed revoking the function-level EXECUTE
-- grant itself, only the underlying table grants), and (b) add the same
-- defense-in-depth verification credit_organizer_wallet already has:
-- confirm the booking exists, is paid, and actually belongs to the named
-- provider, under a row lock, so even a future internal-caller bug can't
-- credit an unrelated or fabricated amount.
--
-- FINDING 2 (hardening, not a live exploit) -- request_organizer_payout had
-- no idempotency key. Its SELECT ... FOR UPDATE on organizer_wallets
-- already makes the core invariant airtight (a concurrent/duplicate call
-- re-reads the post-deduction balance and correctly fails with
-- "Insufficient balance" if it would overdraw) -- but a genuine double-tap
-- or client retry with an available balance that covers both amounts
-- currently creates two separate real withdrawal requests instead of being
-- recognized as the same one. request_vc_cashout (0072-era) already solved
-- this exact problem with a client-supplied idempotency_key + a unique
-- (user_id, idempotency_key) index + ON CONFLICT DO NOTHING; this applies
-- the identical pattern to organizer/service-provider payouts.

-- ── Finding 2: idempotent withdrawal requests ───────────────────────────
ALTER TABLE public.organizer_withdrawal_requests
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_organizer_withdraw_idempotency
  ON public.organizer_withdrawal_requests (organizer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Postgres identifies a function by name + parameter TYPES, not defaults --
-- adding a third parameter makes this a distinct overload rather than a
-- replacement of the existing 2-arg function. Drop the old signature
-- explicitly so only one (unambiguous, idempotency-aware) version exists.
DROP FUNCTION IF EXISTS public.request_organizer_payout(bigint, uuid);

CREATE OR REPLACE FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
  v_account      public.organizer_bank_accounts;
  v_rows         int;
BEGIN
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a withdrawal';
  END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  -- Idempotent replay: the same (organizer, idempotency_key) pair returns
  -- the original request instead of creating (or debiting) a second one --
  -- this is what makes a double-tap or a client network-retry safe rather
  -- than merely "not overdrawing".
  IF p_idempotency_key IS NOT NULL AND trim(p_idempotency_key) <> '' THEN
    SELECT id INTO v_request_id
    FROM public.organizer_withdrawal_requests
    WHERE organizer_id = v_organizer_id AND idempotency_key = p_idempotency_key;
    IF v_request_id IS NOT NULL THEN
      RETURN v_request_id;
    END IF;
  END IF;

  SELECT * INTO v_account FROM public.organizer_bank_accounts
  WHERE id = p_bank_account_id AND organizer_id = v_organizer_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo - p_amount_kobo,
      pending_kobo = pending_kobo + p_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  BEGIN
    INSERT INTO public.organizer_withdrawal_requests
      (organizer_id, amount_kobo, bank_account_id, status, bank_name, bank_code, account_number, account_name, idempotency_key)
    VALUES
      (v_organizer_id, p_amount_kobo, p_bank_account_id, 'pending',
       v_account.bank_name, v_account.bank_code, v_account.account_number, v_account.account_name,
       NULLIF(trim(COALESCE(p_idempotency_key, '')), ''))
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race against a concurrent call carrying the same idempotency
    -- key (both passed the SELECT-based check above before either
    -- inserted): undo the balance move we just made and return the
    -- winner's request instead of the balance getting debited twice for
    -- one logical request.
    UPDATE public.organizer_wallets
    SET balance_kobo = balance_kobo + p_amount_kobo,
        pending_kobo = GREATEST(0, pending_kobo - p_amount_kobo),
        updated_at = now()
    WHERE organizer_id = v_organizer_id;

    SELECT id INTO v_request_id
    FROM public.organizer_withdrawal_requests
    WHERE organizer_id = v_organizer_id AND idempotency_key = p_idempotency_key;
    RETURN v_request_id;
  END;

  RETURN v_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_organizer_payout(bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated, project_admin;

-- ── Finding 1: lock down + harden credit_provider_wallet_for_booking ────
REVOKE EXECUTE ON FUNCTION public.credit_provider_wallet_for_booking(uuid, bigint, uuid, text) FROM authenticated, anon, PUBLIC;

CREATE OR REPLACE FUNCTION public.credit_provider_wallet_for_booking(p_provider_user_id uuid, p_amount_kobo bigint, p_booking_id uuid, p_description text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking record;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: amount must be positive';
  END IF;

  IF p_provider_user_id IS NULL THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: provider_user_id is required';
  END IF;

  IF p_booking_id IS NULL THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: a verified booking_id is required';
  END IF;

  -- Defense-in-depth (this function is never meant to be reachable except
  -- as a nested call from another SECURITY DEFINER payment-confirmation
  -- function, which already verified the payment) -- still verify the
  -- booking is real, paid, and actually belongs to the named provider, the
  -- same guard credit_organizer_wallet applies to ticket sales.
  SELECT b.id, sp.user_id AS provider_user_id, b.payment_status, b.subtotal_kobo
    INTO v_booking
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.id = p_booking_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: booking % does not exist', p_booking_id;
  END IF;

  IF v_booking.provider_user_id IS DISTINCT FROM p_provider_user_id THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: booking % does not belong to provider %', p_booking_id, p_provider_user_id;
  END IF;

  IF p_amount_kobo <> v_booking.subtotal_kobo THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: amount % does not match booking % subtotal %', p_amount_kobo, p_booking_id, v_booking.subtotal_kobo;
  END IF;

  IF v_booking.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: booking % is not paid (status=%)', p_booking_id, v_booking.payment_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizer_transactions
    WHERE type = 'credit' AND metadata->>'service_booking_id' = p_booking_id::text
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo)
  VALUES (p_provider_user_id, p_amount_kobo, p_amount_kobo, 0, 0)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo = public.organizer_wallets.balance_kobo + p_amount_kobo,
        total_earned_kobo = public.organizer_wallets.total_earned_kobo + p_amount_kobo,
        updated_at = now();

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
  VALUES (p_provider_user_id, 'credit', p_amount_kobo, p_description, jsonb_build_object('service_booking_id', p_booking_id));
END;
$function$;
