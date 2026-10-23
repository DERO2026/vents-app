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
-- pattern -- the status check moves INTO the UPDATE's WHERE clause, so a
-- second concurrent call finds no row left to match and gets NULL back.
--
-- Revised after a second, read-only audit against the live function
-- bodies (see that audit's report for the full diff). Two corrections
-- from the first draft of this migration, both confirmed against the
-- live bodies directly:
--
-- 1. admin_reject_organizer_payout's first draft added a "rejection
--    reason is required" check that does NOT exist in the live function
--    today (admin_cancel_processing_payout already has the equivalent
--    check for cancellation; reject does not). That would have been an
--    undisclosed behavior change riding on a bug-fix migration -- this
--    draft was reviewed and is NOT documented anywhere as an intentional
--    change, so it is removed here to keep this migration scoped to only
--    the race fix. (The client already always supplies a reason for
--    reject today; adding server-side enforcement of that, if wanted, is
--    a separate, deliberate change for a future migration.)
--
-- 2. admin_cancel_processing_payout's first draft lost the live
--    function's specific current-status detail in its "wrong status"
--    error ('Only requests in Processing status can be cancelled
--    (current status: %)', v_status) -- the atomic UPDATE's failure case
--    only had the row's id to work with, not its status. Restored by
--    reading the row's current status AFTER the atomic UPDATE has
--    already failed to match, purely to build the error message -- this
--    read never gates a write decision (the UPDATE's own WHERE clause is
--    still the only thing that decides whether the claim succeeds), so it
--    does not reintroduce the TOCTOU window: a second concurrent caller
--    still can't win a race against the atomic UPDATE, it can only read a
--    possibly-stale status for its own rejected attempt's error text.
--
-- All other logic (is_admin_or_root(), payouts_disabled(), the
-- wallet-refund arithmetic, the organizer_transactions/admin_logs inserts,
-- the returned columns, admin_cancel_processing_payout's pre-existing
-- reason-required check) is copied verbatim from the live bodies -- no
-- other behavior change.

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
    -- for the same clear error the live body gives, without a second
    -- unlocked read racing the UPDATE above -- this EXISTS check never
    -- gates the write decision, it only shapes which error message a
    -- caller whose claim already failed receives.
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
  v_current_status text;
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
    -- Read-only, post-failure lookup purely to reproduce the live
    -- function's more specific error message (which names the request's
    -- actual current status). This happens strictly AFTER the atomic
    -- UPDATE above has already failed to match a row, so it cannot be
    -- used to decide whether the claim succeeds -- it only decides which
    -- exception text this already-failed caller receives. It does not
    -- reopen the TOCTOU window the atomic UPDATE closes.
    SELECT r.status INTO v_current_status FROM public.organizer_withdrawal_requests r WHERE r.id = p_request_id;
    IF v_current_status IS NULL THEN
      RAISE EXCEPTION 'Request not found';
    END IF;
    RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_current_status;
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
