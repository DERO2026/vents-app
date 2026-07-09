-- CRITICAL FIX: every admin RPC written in the payout-engine and CAC
-- verification migrations earlier this session calls is_admin() UNQUALIFIED
-- while SET search_path = '' is active. With an empty search_path, Postgres
-- cannot resolve any unqualified identifier — including function calls — so
-- every one of these 7 functions throws
-- 'function is_admin() does not exist' on EVERY invocation, for EVERY
-- caller, admin or not. Confirmed via direct RPC test and a full-codebase
-- audit (pre-existing functions admin_credit_vents_cents and
-- admin_set_user_role already correctly call public.is_admin() — this
-- session's new functions were the only ones missing the qualifier).
--
-- This is the real root cause of "Requests -> Pending renders empty" (the
-- RPC always threw; the client's Promise.all destructured only `data` and
-- silently discarded `error`) and meant the live Approve & Pay / Reject &
-- Refund buttons have been failing on every click since they were added.
--
-- Fix: schema-qualify every is_admin() call as public.is_admin(). No other
-- behavior changes — bodies are otherwise identical to their prior versions.

CREATE OR REPLACE FUNCTION public.admin_get_payout_for_processing(p_request_id uuid)
RETURNS TABLE (request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_get_payout_for_processing TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(
  p_request_id uuid, p_paystack_reference text, p_transfer_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', paystack_reference = p_paystack_reference, transfer_code = p_transfer_code, updated_at = now()
  WHERE id = p_request_id AND status = 'pending';
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_mark_payout_processing TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests WHERE id = p_request_id;
  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, updated_at = now() WHERE id = p_request_id;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;
  RETURN 'rejected';
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_payout TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_pending_payouts()
RETURNS TABLE (
  request_id uuid, organizer_id uuid, organizer_name text, organizer_email text, organizer_phone text,
  amount_kobo bigint, bank_name text, account_number text, account_name text, recipient_code text,
  status text, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, u.full_name, u.email, u.phone_number,
    r.amount_kobo, b.bank_name, b.account_number, b.account_name, b.recipient_code,
    r.status, r.created_at
  FROM public.organizer_withdrawal_requests r
  JOIN public.users u ON u.id = r.organizer_id
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.status IN ('pending', 'processing')
  ORDER BY r.created_at ASC;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_payouts TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
  UPDATE public.users SET is_verified = true WHERE id = v_user_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_approve_organizer_verification TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_verification TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_organizer_verifications()
RETURNS TABLE (
  request_id uuid, user_id uuid, full_name text, email text, phone_number text, state text,
  company_name text, cac_number text, business_address text, document_url text,
  status text, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email, u.phone_number, u.state,
    r.company_name, r.cac_number, r.business_address, r.document_url, r.status, r.created_at
  FROM public.organizer_verification_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE r.status = 'pending'
  ORDER BY r.created_at ASC;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_list_organizer_verifications TO authenticated;
