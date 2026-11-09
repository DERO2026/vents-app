-- Undo 0211 (withdrawal PIN and the sub-admin-capable two-admin approval).
-- Restores the 0203 / 0205 / live bodies 0211 replaced (verbatim), gives
-- clients back request_organizer_payout, and drops what 0211 added.
--
-- Money, withdrawal requests, their approvals, admin requests and the ledger
-- are NOT touched. Withdrawal PINs ARE deleted (withdrawal_pins and its
-- event log are dropped): after a rollback the app must also be rolled back
-- to a build that does not ask for a PIN. Approvals given by a sub-admin
-- under 0211 stay valid (an approval never changes); new second approvals
-- again need a super admin.
-- Refuses unless the operator confirms: SET vents.rollback_confirm = 'undo-0211';
DO $guard$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0211' THEN
    RAISE EXCEPTION 'undo_0211: set vents.rollback_confirm = ''undo-0211'' to confirm';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS authorize_withdrawal_first_approval_check ON public.admin_action_requests;
DROP TRIGGER IF EXISTS withdrawal_close_open_authorizations ON public.organizer_withdrawal_requests;

-- 0205 (verbatim)
CREATE OR REPLACE FUNCTION public.organizer_withdrawal_requests_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_has_transfer boolean := OLD.transfer_code IS NOT NULL;
BEGIN
  IF NEW.organizer_id IS DISTINCT FROM OLD.organizer_id OR NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo THEN
    RAISE EXCEPTION 'Withdrawal %: its owner and amount cannot be changed', OLD.id;
  END IF;
  IF OLD.transfer_code IS NOT NULL AND NEW.transfer_code IS DISTINCT FROM OLD.transfer_code THEN
    RAISE EXCEPTION 'Withdrawal %: its Paystack transfer code cannot be changed or cleared', OLD.id;
  END IF;
  IF OLD.paystack_reference IS NOT NULL AND NEW.paystack_reference IS DISTINCT FROM OLD.paystack_reference THEN
    RAISE EXCEPTION 'Withdrawal %: its Paystack reference cannot be changed or cleared', OLD.id;
  END IF;

  -- Two-admin authorization (0203) cannot be forged, altered or erased by a
  -- raw UPDATE. Once set it never changes. It can only be set inside
  -- approve_admin_action for this request's own pending authorize_withdrawal
  -- request, by the super admin approving it, who is not the requester.
  IF NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_requested_by IS DISTINCT FROM OLD.approval_requested_by
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_recipient_code IS DISTINCT FROM OLD.approved_recipient_code THEN
    IF OLD.approved_by IS NOT NULL OR OLD.approval_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Withdrawal %: its two-admin authorization cannot be changed or cleared', OLD.id;
    END IF;
    IF NEW.approved_by IS NULL OR NEW.approval_request_id IS NULL OR NEW.approved_recipient_code IS NULL
       OR NEW.approved_by IS DISTINCT FROM auth.uid() OR NOT public.is_super_admin()
       OR NOT EXISTS (SELECT 1 FROM public.admin_action_requests q
                       WHERE q.id = NEW.approval_request_id AND q.action_type = 'authorize_withdrawal'
                         AND q.target_id = OLD.id AND q.status = 'pending'
                         AND q.requested_by = NEW.approval_requested_by
                         AND q.requested_by IS DISTINCT FROM NEW.approved_by) THEN
      RAISE EXCEPTION 'Withdrawal %: a two-admin authorization can only be recorded by approve_admin_action for its own authorize_withdrawal request', OLD.id;
    END IF;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Once a transfer may exist, only Paystack's outcome ends the request.
  IF NEW.status IN ('cancelled', 'rejected', 'pending')
     AND (v_has_transfer
          OR (NEW.status <> 'pending' AND OLD.status = 'processing' AND OLD.paystack_reference IS NOT NULL)) THEN
    RAISE EXCEPTION 'Withdrawal %: a Paystack transfer exists or may exist (%), so it cannot be set to %; only Paystack''s outcome (completed, failed, reversed) can end it. Use Reconcile.',
      OLD.id, COALESCE(OLD.transfer_code, OLD.paystack_reference), NEW.status;
  END IF;

  -- Only an authorized request may be claimed for Paystack (0203's claim
  -- enforces this; this stops a raw UPDATE from skipping it).
  IF OLD.status = 'pending' AND NEW.status = 'processing' AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Withdrawal %: it needs two-admin authorization before it can be claimed for payment', OLD.id;
  END IF;

  -- Final states stay final.
  IF OLD.status IN ('failed', 'rejected', 'reversed')
     OR (OLD.status = 'completed' AND NEW.status <> 'reversed')
     OR (OLD.status = 'cancelled' AND NEW.status <> 'completed') THEN
    RAISE EXCEPTION 'Withdrawal %: a final status cannot change (% -> %)', OLD.id, OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'reversed' AND OLD.status <> 'completed' THEN
    RAISE EXCEPTION 'Withdrawal %: only a completed request can be reversed (it is %)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.organizer_withdrawal_requests_guard() FROM PUBLIC, anon, authenticated;

-- 0203 (verbatim)
CREATE OR REPLACE FUNCTION public.execute_withdrawal_authorization(p_admin_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  w public.organizer_withdrawal_requests;
  v_approver uuid := auth.uid();
  v_recipient text;
BEGIN
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_admin_request_id;
  IF NOT FOUND OR r.action_type <> 'authorize_withdrawal' THEN
    RAISE EXCEPTION 'Not a withdrawal authorization request';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF v_approver IS NULL OR r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  IF r.target_id IS NULL OR (r.payload ? 'request_id' AND r.payload->>'request_id' IS DISTINCT FROM r.target_id::text) THEN
    RAISE EXCEPTION 'The authorization must name exactly one withdrawal request';
  END IF;
  IF jsonb_typeof(r.payload->'amount_kobo') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'payload.amount_kobo (the amount the requesting admin reviewed) is required';
  END IF;

  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = r.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal request is %, not pending', w.status; END IF;
  IF w.approved_by IS NOT NULL THEN RAISE EXCEPTION 'Withdrawal request is already authorized'; END IF;
  IF w.organizer_id IN (r.requested_by, v_approver) THEN
    RAISE EXCEPTION 'An admin cannot request or approve their own withdrawal';
  END IF;
  IF (r.payload->>'amount_kobo')::numeric <> w.amount_kobo THEN
    RAISE EXCEPTION 'The amount reviewed (%) does not match the request (%)', r.payload->>'amount_kobo', w.amount_kobo;
  END IF;

  -- Only an account the organizer still has active: the claim refuses an
  -- inactive one, so authorizing it would leave an approval nobody can pay.
  SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b
   WHERE b.id = w.bank_account_id AND b.is_active;
  IF v_recipient IS NULL THEN
    RAISE EXCEPTION 'The withdrawal''s bank account is inactive or has no verified recipient; the organizer must withdraw to an active account';
  END IF;

  UPDATE public.organizer_withdrawal_requests
     SET approval_request_id = r.id, approval_requested_by = r.requested_by,
         approved_by = v_approver, approved_at = now(), approved_recipient_code = v_recipient,
         updated_at = now()
   WHERE id = w.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_approver, 'withdrawal_authorized', w.organizer_id,
          jsonb_build_object('request_id', w.id, 'admin_request_id', r.id, 'requested_by', r.requested_by,
                             'approved_by', v_approver, 'amount_kobo', w.amount_kobo),
          public.actor_role());
END;
$function$;

-- Live definition (0004, verbatim)
-- Function: assert_recent_auth
CREATE OR REPLACE FUNCTION public.assert_recent_auth()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_iat bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  BEGIN
    v_iat := (auth.jwt() ->> 'iat')::bigint;
  EXCEPTION WHEN others THEN v_iat := NULL; END;
  IF v_iat IS NULL OR (extract(epoch FROM now())::bigint - v_iat) > 300 THEN
    RAISE EXCEPTION 'PASSWORD_CONFIRMATION_REQUIRED';
  END IF;
END; $function$
;

GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS public.request_withdrawal(bigint, uuid, text, text);
DROP FUNCTION IF EXISTS public.withdrawal_pin_check(uuid, text);
DROP FUNCTION IF EXISTS public.reset_my_withdrawal_pin(text, text);
DROP FUNCTION IF EXISTS public.set_my_withdrawal_pin(text, text);
DROP FUNCTION IF EXISTS public.get_my_withdrawal_pin_status();
DROP FUNCTION IF EXISTS public.withdrawal_password_recently_confirmed();
DROP FUNCTION IF EXISTS public.withdrawal_pin_validate(text, text);
DROP FUNCTION IF EXISTS public.withdrawal_pin_is_weak(text);
DROP FUNCTION IF EXISTS public.withdrawal_pin_matches(uuid, text, text);
DROP FUNCTION IF EXISTS public.withdrawal_pin_hash(uuid, text);
DROP FUNCTION IF EXISTS public.withdrawal_pin_policy();
DROP TABLE IF EXISTS public.withdrawal_pin_events;
DROP TABLE IF EXISTS public.withdrawal_pins;
DROP FUNCTION IF EXISTS public.get_my_withdrawals(integer);
DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer);
DROP FUNCTION IF EXISTS public.admin_cancel_withdrawal_first_approval(uuid, text);
DROP FUNCTION IF EXISTS public.admin_approve_withdrawal(uuid);
DROP FUNCTION IF EXISTS public.admin_first_approve_withdrawal(uuid, bigint);
DROP FUNCTION IF EXISTS public.withdrawal_close_open_authorizations();
DROP FUNCTION IF EXISTS public.authorize_withdrawal_first_approval_check();
DROP FUNCTION IF EXISTS public.withdrawal_naira(bigint);
DROP FUNCTION IF EXISTS public.withdrawal_stage(text, uuid, boolean);
DROP FUNCTION IF EXISTS public.withdrawal_approval_allowed(uuid, uuid);
DROP FUNCTION IF EXISTS public.withdrawal_admin_tier(uuid);
