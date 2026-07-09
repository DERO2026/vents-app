-- Extend complete_organizer_payout / fail_organizer_payout to return the
-- organizer's email/name/amount alongside the status string, so the
-- Paystack webhook (the authoritative signal for "money actually moved")
-- can fire the payout confirmation/failure email itself, rather than the
-- admin's synchronous approve click — which only means "Paystack accepted
-- the transfer for processing", not "the money has arrived".
--
-- Only api/webhook/paystack.ts calls these two RPCs, so widening the
-- return shape from `text` to a row type is safe.

DROP FUNCTION IF EXISTS public.complete_organizer_payout(text);
CREATE OR REPLACE FUNCTION public.complete_organizer_payout(p_request_id text)
RETURNS TABLE (status text, organizer_email text, organizer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text; v_bank_name text;
BEGIN
  SELECT r.organizer_id, r.amount_kobo, r.status, b.bank_name
    INTO v_organizer_id, v_amount_kobo, v_status, v_bank_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id;

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
  WHERE organizer_id = v_organizer_id AND amount_kobo = v_amount_kobo AND status IN ('pending', 'processing')
    AND (id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id);

  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo, updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description)
  VALUES (v_organizer_id, 'payout', v_amount_kobo, 'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed');

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.complete_organizer_payout(text) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.fail_organizer_payout(text, text);
CREATE OR REPLACE FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text)
RETURNS TABLE (status text, organizer_email text, organizer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text;
BEGIN
  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE organizer_id = v_organizer_id AND amount_kobo = v_amount_kobo AND status IN ('pending', 'processing')
    AND (id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id);

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.fail_organizer_payout(text, text) TO anon, authenticated;
