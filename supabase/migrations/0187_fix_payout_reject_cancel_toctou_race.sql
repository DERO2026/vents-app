-- NOT YET APPLIED TO PRODUCTION -- drafted for review, pending explicit
-- authorization, per this task's explicit instruction not to run
-- migrations or modify production data. Confirmed live via
-- pg_get_functiondef (project slrtjxtzhowhwhebjprv) that both functions
-- below currently have the bug this migration fixes.
--
-- The bug: admin_reject_organizer_payout and admin_cancel_processing_payout
-- both read the request's current status with a plain, unlocked SELECT,
-- check it in application logic, then perform a SEPARATE UPDATE that is
-- NOT reconditioned on that status. Two concurrent calls for the same
-- request_id (a double-click on ConfirmModal's own Confirm button, which
-- has no busy state of its own -- see AdminPayoutsScreen.tsx's new
-- actionInFlightRef for the client-side half of this mitigation) can both
-- read the same pre-write status, both pass the check, and both execute
-- the wallet-refund UPDATE -- crediting the organizer's wallet TWICE for
-- one rejected or cancelled withdrawal request.
--
-- This is exactly the class of bug admin_claim_payout_for_processing (the
-- Approve path, confirmed live, unchanged by this migration) already gets
-- right: a single atomic `UPDATE ... WHERE status = 'pending'` with no
-- prior unlocked SELECT, so only the caller whose UPDATE actually matched
-- a row proceeds. Both functions below are rewritten to use the identical
-- pattern -- the status check moves INTO the UPDATE's WHERE clause, and a
-- row count check (GET DIAGNOSTICS) replaces the separate SELECT-derived
-- check. All other logic (is_admin_or_root(), payouts_disabled(), the
-- wallet-refund arithmetic, the organizer_transactions/admin_logs inserts,
-- the returned columns) is copied verbatim from the live bodies -- no
-- unrelated behavior change.

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;

  -- Atomic claim: the status check and the write happen in the SAME
  -- statement, so a second concurrent call for the same request_id finds
  -- no row left to match (it's no longer 'pending') and gets NULL back --
  -- exactly the admin_claim_payout_for_processing pattern.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;

  IF v_organizer_id IS NULL THEN
    -- Distinguish "doesn't exist" from "exists but isn't pending anymore"
    -- for the same clear error the old body gave, without a second
    -- unlocked read racing the UPDATE above.
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
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  -- Same atomic-claim fix as admin_reject_organizer_payout above.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'processing'
  RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo;

  IF v_organizer_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizer_withdrawal_requests WHERE id = p_request_id) THEN
      RAISE EXCEPTION 'Request not found';
    END IF;
    RAISE EXCEPTION 'Only requests in Processing status can be cancelled';
  END IF;

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
END;
$function$;
