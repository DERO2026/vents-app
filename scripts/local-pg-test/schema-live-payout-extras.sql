-- Live helpers and the two live payout functions 0202 does not replace
-- (fail_organizer_payout, admin_reject_organizer_payout; production,
-- 2026-10-30). Loaded after 0201 by the payout and earnings tests.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;
CREATE OR REPLACE FUNCTION public.is_admin_or_root() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS
$$ SELECT public.is_super_admin() $$;

CREATE OR REPLACE FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_id uuid; v_organizer_id uuid; v_amount_kobo bigint; v_status text; v_rows int;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status
    INTO v_id, v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests r
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE;
  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'fail_payout', v_organizer_id,
          jsonb_build_object('request_id', v_id, 'previous_status', v_status, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          COALESCE(public.actor_role(), 'system:project_admin'));
  RETURN QUERY SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid; v_amount_kobo bigint;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN RAISE EXCEPTION 'payouts_disabled'; END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;
  IF v_organizer_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizer_withdrawal_requests WHERE id = p_request_id) THEN
      RAISE EXCEPTION 'Request not found';
    END IF;
    RAISE EXCEPTION 'Only pending requests can be rejected';
  END IF;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_payout_request', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason), public.actor_role());
  RETURN 'rejected';
END;
$function$;

-- Live-equivalent client grants for the admin payout RPCs.
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_payout(uuid, text) TO authenticated;
