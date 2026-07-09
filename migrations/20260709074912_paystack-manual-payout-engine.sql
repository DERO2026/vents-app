-- Paystack manual-approval organizer payout engine.
--
-- Reuses the existing organizer_wallets / organizer_bank_accounts /
-- organizer_withdrawal_requests tables (created earlier) instead of a
-- parallel "payout_requests" table — they already model exactly what's
-- needed. This migration fixes the real bug found in an earlier read-only
-- audit: request_organizer_payout decremented balance_kobo and inserted a
-- completed-looking 'payout' transaction row immediately at request time,
-- before any admin approval or real transfer. It now moves funds into a
-- pending_kobo hold instead, and no transaction row is written until the
-- payout genuinely completes (or is rejected/fails, in which case it's
-- rolled back and no transaction row is written at all).

-- ── Schema additions ────────────────────────────────────────────────────

ALTER TABLE public.organizer_wallets
  ADD COLUMN IF NOT EXISTS pending_kobo bigint NOT NULL DEFAULT 0;

ALTER TABLE public.organizer_bank_accounts
  ADD COLUMN IF NOT EXISTS bank_code text,
  ADD COLUMN IF NOT EXISTS recipient_code text;

ALTER TABLE public.organizer_withdrawal_requests
  ADD COLUMN IF NOT EXISTS paystack_reference text,
  ADD COLUMN IF NOT EXISTS transfer_code text;

-- 'pending' -> 'processing' (transfer initiated) -> 'completed' | 'failed'
-- via webhook, or 'rejected' by an admin before any transfer is attempted.
ALTER TABLE public.organizer_withdrawal_requests
  DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_status_check;
ALTER TABLE public.organizer_withdrawal_requests
  ADD CONSTRAINT organizer_withdrawal_requests_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'rejected'));

-- ── RLS: admin needs read access to review pending payouts ─────────────
-- (admin already had UPDATE on withdrawal_requests and ALL on wallets;
-- read access was missing on both requests and bank accounts.)

DROP POLICY IF EXISTS org_withdraw_admin_read ON public.organizer_withdrawal_requests;
CREATE POLICY org_withdraw_admin_read ON public.organizer_withdrawal_requests
  FOR SELECT USING (is_admin());

DROP POLICY IF EXISTS org_bank_admin_read ON public.organizer_bank_accounts;
CREATE POLICY org_bank_admin_read ON public.organizer_bank_accounts
  FOR SELECT USING (is_admin());

-- ── RPC: upsert a verified bank account + Paystack recipient_code ───────
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

GRANT EXECUTE ON FUNCTION public.upsert_organizer_bank_account TO authenticated;

-- ── RPC: request_organizer_payout — FIXED to hold funds as pending ─────
-- instead of decrementing the ledger and writing a completed-looking
-- transaction row before anything has actually happened.
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

-- ── RPC: admin fetches recipient_code + amount right before initiating a
-- Paystack transfer for a request.
CREATE OR REPLACE FUNCTION public.admin_get_payout_for_processing(p_request_id uuid)
RETURNS TABLE (
  request_id uuid,
  organizer_id uuid,
  amount_kobo bigint,
  recipient_code text,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_payout_for_processing TO authenticated;

-- ── RPC: mark 'processing' once Paystack has accepted the transfer ─────
CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(
  p_request_id uuid,
  p_paystack_reference text,
  p_transfer_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing',
      paystack_reference = p_paystack_reference,
      transfer_code = p_transfer_code,
      updated_at = now()
  WHERE id = p_request_id AND status = 'pending';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_mark_payout_processing TO authenticated;

-- ── RPC: complete a payout — idempotent, callable from both the
-- synchronous approve path AND the transfer.success webhook. Only the
-- FIRST call does anything; a second call (e.g. webhook arriving after
-- the request already completed some other way) is a safe no-op.
CREATE OR REPLACE FUNCTION public.complete_organizer_payout(
  p_request_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_bank_name text;
BEGIN
  SELECT r.organizer_id, r.amount_kobo, r.status, b.bank_name
    INTO v_organizer_id, v_amount_kobo, v_status, v_bank_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id;

  IF v_organizer_id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF v_status = 'completed' THEN
    RETURN 'already_completed';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE organizer_id = v_organizer_id AND amount_kobo = v_amount_kobo AND status IN ('pending', 'processing')
    AND (id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id);

  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description)
  VALUES (v_organizer_id, 'payout', v_amount_kobo, 'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed');

  RETURN 'completed';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_organizer_payout(text) TO anon, authenticated;

-- ── RPC: fail a payout (transfer.failed / transfer.reversed) — idempotent,
-- rolls the held funds back to the available balance.
CREATE OR REPLACE FUNCTION public.fail_organizer_payout(
  p_request_id text,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id;

  IF v_organizer_id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN 'already_finalized';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE organizer_id = v_organizer_id AND amount_kobo = v_amount_kobo AND status IN ('pending', 'processing')
    AND (id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id);

  -- Roll the held funds back to available.
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN 'failed';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) TO anon, authenticated;

-- ── RPC: admin rejects a pending request before any transfer attempt ───
CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(
  p_request_id uuid,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests WHERE id = p_request_id;

  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_status NOT IN ('pending') THEN
    RAISE EXCEPTION 'Only pending requests can be rejected';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN 'rejected';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_payout TO authenticated;

-- ── RPC: admin view of pending payouts with organizer + bank metadata ──
CREATE OR REPLACE FUNCTION public.admin_list_pending_payouts()
RETURNS TABLE (
  request_id uuid,
  organizer_id uuid,
  organizer_name text,
  organizer_email text,
  organizer_phone text,
  amount_kobo bigint,
  bank_name text,
  account_number text,
  account_name text,
  recipient_code text,
  status text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT
    r.id, r.organizer_id, u.full_name, u.email, u.phone_number,
    r.amount_kobo, b.bank_name, b.account_number, b.account_name, b.recipient_code,
    r.status, r.created_at
  FROM public.organizer_withdrawal_requests r
  JOIN public.users u ON u.id = r.organizer_id
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.status IN ('pending', 'processing')
  ORDER BY r.created_at ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_list_pending_payouts TO authenticated;
