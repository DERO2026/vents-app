-- Gate wallet features on email verification.
--
-- InsForge already enforces mandatory email verification at signup
-- (insforge.toml: require_email_verification = true, code method) — an
-- unverified user cannot obtain a session in the first place, and
-- auth.users.email_verified is the platform's own source of truth for
-- that state. This does NOT reuse public.users.is_verified, which already
-- means something unrelated in this schema (the CAC/business-document
-- "verified organizer" badge, set only by admin_approve_organizer_verification).
--
-- This migration adds a defense-in-depth check at the two organizer-facing
-- wallet entry points that lead to money leaving the platform — requesting
-- a withdrawal and saving a payout bank account — so a session that
-- somehow predates or bypasses the platform gate (e.g. a legacy account
-- created before require_email_verification was turned on) still can't
-- reach those actions.

CREATE OR REPLACE FUNCTION public.is_email_verified()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(email_verified, false) FROM auth.users WHERE id = auth.uid();
$function$;

GRANT EXECUTE ON FUNCTION public.is_email_verified() TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_organizer_bank_account(
  p_bank_name text,
  p_bank_code text,
  p_account_number text,
  p_account_name text,
  p_recipient_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before adding a payout bank account';
  END IF;

  INSERT INTO public.organizer_bank_accounts
    (organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, updated_at)
  VALUES
    (v_organizer_id, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, now())
  ON CONFLICT (organizer_id) DO UPDATE
    SET bank_name = EXCLUDED.bank_name,
        bank_code = EXCLUDED.bank_code,
        account_number = EXCLUDED.account_number,
        account_name = EXCLUDED.account_name,
        recipient_code = EXCLUDED.recipient_code,
        updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_organizer_payout(
  p_amount_kobo     bigint,
  p_bank_account_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
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

  IF NOT EXISTS (
    SELECT 1 FROM public.organizer_bank_accounts
    WHERE id = p_bank_account_id AND organizer_id = v_organizer_id AND recipient_code IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  -- Row lock on the wallet row prevents a concurrent double-spend from two
  -- simultaneous withdrawal requests racing against the same balance.
  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  -- Move funds available -> pending. Total (balance + pending) is
  -- unchanged, so nothing is "lost" from the organizer's perspective —
  -- it's held, not spent, until an admin actually approves it.
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo - p_amount_kobo,
      pending_kobo = pending_kobo + p_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_withdrawal_requests (organizer_id, amount_kobo, bank_account_id, status)
  VALUES (v_organizer_id, p_amount_kobo, p_bank_account_id, 'pending')
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$function$;
