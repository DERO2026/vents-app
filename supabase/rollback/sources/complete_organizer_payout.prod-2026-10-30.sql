-- Production's complete_organizer_payout, captured read-only on 2026-10-30 (pg_get_functiondef)
-- while writing 0202. md5(prosrc) = 563304a9394f6fb5148b2d458ce945f6, the value production
-- reported. This body is in no migration file: production was changed outside the repo.
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

  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
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

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'complete_payout',
    v_organizer_id,
    jsonb_build_object(
      'request_id', v_id,
      'lookup_key', p_request_id,
      'previous_status', v_status,
      'new_status', 'completed',
      'amount_kobo', v_amount_kobo,
      'bank_name', v_bank_name,
      'account_number', v_account_number
    ),
    COALESCE(public.actor_role(), 'system:project_admin')
  );

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$
;
