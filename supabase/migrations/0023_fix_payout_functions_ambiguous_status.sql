-- Fixes the same ambiguous-`status`-column bug (see
-- 0022_fix_admin_claim_payout_ambiguous_status.sql) in the other three
-- payout functions that share the RETURNS TABLE(..., status text, ...)
-- shape: admin_cancel_processing_payout, complete_organizer_payout,
-- fail_organizer_payout. Found live while verifying the payout-approval
-- flow end to end - every bare `status` reference throughout the function
-- body (not just WHERE clauses) is ambiguous once an OUT parameter of the
-- same name is in scope, confirmed against complete_organizer_payout's
-- WHERE clause and inferred to apply equally to the SELECT ... INTO lines
-- in the other two (same PL/pgSQL name-resolution rule, not clause-
-- specific). Column qualified with the table name throughout; no
-- behavior change otherwise.

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT organizer_id, amount_kobo, public.organizer_withdrawal_requests.status
    INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id = p_request_id;

  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_organizer_id, 'cancelled_payout_refund', v_amount_kobo,
          'Payout request cancelled by admin, funds returned — ' || p_reason, p_request_id);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_payout', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.complete_organizer_payout(p_request_id text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_bank_name text;
  v_account_number text;
  v_account_name text;
  v_rows int;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, b.bank_name, b.account_number, b.account_name
    INTO v_id, v_organizer_id, v_amount_kobo, v_status, v_bank_name, v_account_number, v_account_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE OF r;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status = 'completed' THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  -- Matched by the exact row id found above — not by amount/status, which
  -- could otherwise also match a sibling request for the same amount.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Lost the race to a concurrent call (or webhook retry) between our
    -- initial locked read and here -- someone else already finalized this
    -- request. Do NOT touch the wallet/ledger a second time.
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions
    (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (
    v_organizer_id, 'payout', v_amount_kobo,
    'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed',
    v_id,
    jsonb_build_object('bank_name', v_bank_name, 'account_number', v_account_number, 'account_name', v_account_name)
  );

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_rows int;
BEGIN
  SELECT id, organizer_id, amount_kobo, public.organizer_withdrawal_requests.status
    INTO v_id, v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id
  FOR UPDATE;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  -- Matched by the exact row id found above (same fix as complete_organizer_payout).
  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;
