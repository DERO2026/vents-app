-- 0211: withdrawal PIN, and a working two-admin withdrawal approval for
-- admins AND sub-admins, with one authoritative state for every screen.
--
-- NOT APPLIED TO PRODUCTION. Verified only against a local throwaway
-- PostgreSQL (scripts/local-pg-test/run-withdrawal-pin-approval-verification.sh).
-- Prerequisites: 0203, 0205, 0207 (checked below). One transaction; idempotent.
-- Rollback: supabase/rollback/undo_0211.sql.
--
-- 1. Withdrawal PIN (replaces Face ID / biometrics on withdrawals).
--    * A dedicated 4-digit PIN, separate from the login password and OTPs.
--      Stored only as a bcrypt hash bound to the user id (pgcrypto); no
--      function returns it, and the table is closed to every client role.
--    * Created once, entered twice (set_my_withdrawal_pin). Changed or reset
--      only with the account password confirmed seconds earlier
--      (reset_my_withdrawal_pin; the API checks the password and calls it
--      with the fresh session it gets). A reset pauses new withdrawals for
--      24 hours and notifies the user.
--    * 5 wrong PINs lock it for 30 minutes; the 3rd lock in a row requires
--      a reset. Failed attempts are committed (the PIN check returns its
--      result instead of raising, so a rollback never erases a failure).
--    * request_withdrawal(amount, bank account, PIN, idempotency key) is the
--      ONLY way to request a withdrawal: request_organizer_payout is no
--      longer callable by clients. It also enforces the ₦100 minimum and
--      refuses an identical request made in the last 2 minutes, holding the
--      wallet row lock so two concurrent requests cannot both pass.
--
-- 2. Two-admin approval that sub-admins can take part in.
--    * Before: the first approval (request_admin_action 'authorize_withdrawal')
--      was open to any admin, but the second could only be given by a super
--      admin, in Admin Actions, so a sub-admin's approval always failed with
--      "Super Admin access required", and several first approvals could pile
--      up for one withdrawal.
--    * Now: two DIFFERENT admins, neither the withdrawing user, and at least
--      one of them a full admin. A sub-admin may give either approval; two
--      sub-admins alone cannot authorize a withdrawal (the rule before 0211
--      required a super admin for the second approval; this keeps a full
--      admin in every authorization).
--    * One first approval per withdrawal (trigger, under the withdrawal's row
--      lock); it records the bank recipient it reviewed, and the second
--      approval refuses if the bank changed in between.
--    * admin_first_approve_withdrawal / admin_approve_withdrawal /
--      admin_cancel_withdrawal_first_approval are the dashboard actions;
--      approve_admin_action (Admin Actions) still works and follows the same
--      rule. Nothing reaches Paystack before both approvals:
--      admin_claim_payout_for_processing (0203) and the 0205 guard refuse it.
--    * A first approval left open when its withdrawal is rejected or
--      cancelled is closed automatically.
--
-- 3. One authoritative state: admin_list_withdrawals() (admins and sub-admins
--    see the same rows, stage and approvers, plus what THIS admin may do and
--    why not) and get_my_withdrawals() (the user's own history and stage).
--    Stages: pending_first_approval, pending_second_approval, approved
--    (ready to pay), processing, paid, rejected, failed, cancelled, reversed.
--
-- 4. assert_recent_auth (bank account changes) and the PIN reset now require
--    the password to have been entered within 5 minutes (the JWT's amr
--    claim), not merely a token issued within 5 minutes: a silently
--    refreshed session also has a fresh iat.
--
-- No money moves, no existing withdrawal or approval changes, no fee,
-- balance, hold, ledger or payout rule is relaxed.

-- ---------------------------------------------------------------------------
-- Prerequisites and drift guard
-- ---------------------------------------------------------------------------
DO $pre0211$
DECLARE
  v_local boolean := COALESCE(current_setting('vents.migration_local_test', true), '') = 'on'
                     AND current_database() LIKE 'vents\_local\_pg\_%';
  v_src text;
BEGIN
  IF to_regprocedure('public.execute_withdrawal_authorization(uuid)') IS NULL
     OR to_regprocedure('public.organizer_withdrawal_requests_guard()') IS NULL
     OR to_regprocedure('public.mask_account_number(text)') IS NULL
     OR to_regprocedure('public.request_organizer_payout(bigint,uuid,text)') IS NULL
     OR to_regprocedure('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)') IS NULL
     OR to_regprocedure('public.assert_recent_auth()') IS NULL THEN
    RAISE EXCEPTION '0211 requires 0203, 0205 and 0207 (and the live assert_recent_auth / request_organizer_payout)';
  END IF;
  -- Replaced wholesale: each must still be the body 0211 was written
  -- against (0205 / 0203 as shipped) or already 0211's own.
  SELECT md5(prosrc) INTO v_src FROM pg_proc WHERE oid = 'public.organizer_withdrawal_requests_guard()'::regprocedure;
  IF v_src NOT IN ('a4db3afdceb377970bf22dc65e21ee3c', '03cd98dc83d83b72868355f5ffcc04c0') AND NOT v_local THEN
    RAISE EXCEPTION '0211: organizer_withdrawal_requests_guard differs from 0205 (md5 %); re-read it and regenerate 0211', v_src;
  END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc WHERE oid = 'public.execute_withdrawal_authorization(uuid)'::regprocedure;
  IF v_src NOT IN ('5bc15fbc84de4edbc0242d5069fa4bc7', 'c46d5a83fb7e95941a157b3300883ff0') AND NOT v_local THEN
    RAISE EXCEPTION '0211: execute_withdrawal_authorization differs from 0203 (md5 %); re-read it and regenerate 0211', v_src;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.assert_recent_auth()'::regprocedure;
  IF position('PASSWORD_CONFIRMATION_REQUIRED' IN v_src) = 0 THEN
    RAISE EXCEPTION '0211: assert_recent_auth no longer raises PASSWORD_CONFIRMATION_REQUIRED; re-read it before replacing';
  END IF;
END
$pre0211$;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
-- 'full' (admin or root), 'sub' (sub-admin) or NULL (not an admin).
CREATE OR REPLACE FUNCTION public.withdrawal_admin_tier(p_user uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
           WHEN p_user IS NULL THEN NULL
           WHEN p_user = auth.uid() AND public.is_root() THEN 'full'
           WHEN u.role = 'admin' THEN 'full'
           WHEN u.role = 'sub-admin' THEN 'sub'
         END
    FROM (SELECT 1) one
    LEFT JOIN public.users u ON u.id = p_user;
$function$;

-- Two different admins, at least one of them a full admin.
CREATE OR REPLACE FUNCTION public.withdrawal_approval_allowed(p_first uuid, p_second uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    p_first IS NOT NULL AND p_second IS NOT NULL AND p_first <> p_second
    AND public.withdrawal_admin_tier(p_first) IS NOT NULL
    AND public.withdrawal_admin_tier(p_second) IS NOT NULL
    AND (public.withdrawal_admin_tier(p_first) = 'full' OR public.withdrawal_admin_tier(p_second) = 'full'),
    false);
$function$;

CREATE OR REPLACE FUNCTION public.withdrawal_stage(p_status text, p_approved_by uuid, p_has_first_approval boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_status
           WHEN 'pending' THEN CASE WHEN p_approved_by IS NOT NULL THEN 'approved'
                                    WHEN p_has_first_approval THEN 'pending_second_approval'
                                    ELSE 'pending_first_approval' END
           WHEN 'processing' THEN 'processing'
           WHEN 'completed' THEN 'paid'
           ELSE p_status
         END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Two-admin approval
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.withdrawal_naira(p_kobo bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT '₦' || to_char(COALESCE(p_kobo, 0) / 100.0, 'FM999,999,999,990.00');
$function$;


-- 0205's guard; [0211] marks the one rule that changes.
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
  -- raw UPDATE. Once set it never changes. It can only be set for this
  -- request's own pending authorize_withdrawal request (the first approval),
  -- by the admin giving the second approval, who is not the first approver.
  IF NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_requested_by IS DISTINCT FROM OLD.approval_requested_by
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_recipient_code IS DISTINCT FROM OLD.approved_recipient_code THEN
    IF OLD.approved_by IS NOT NULL OR OLD.approval_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Withdrawal %: its two-admin authorization cannot be changed or cleared', OLD.id;
    END IF;
    IF NEW.approved_by IS NULL OR NEW.approval_request_id IS NULL OR NEW.approved_recipient_code IS NULL
       OR NEW.approved_by IS DISTINCT FROM auth.uid()
       -- [0211] was NOT public.is_super_admin(): two different admins, at
       -- least one of them a full admin (a sub-admin may be either one).
       OR NOT public.withdrawal_approval_allowed(NEW.approval_requested_by, NEW.approved_by)
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


-- 0203's executor; [0211] marks the changes. Runs inside approve_admin_action
-- (Admin Actions) and admin_approve_withdrawal (Payouts), both of which lock
-- the first-approval request row.
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
  -- [0211] any admin may give the second approval (was: super admins only),
  -- provided the two approvers are different and one is a full admin.
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF v_approver IS NULL OR r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  IF NOT public.withdrawal_approval_allowed(r.requested_by, v_approver) THEN
    RAISE EXCEPTION 'A withdrawal needs two different admins, at least one of them a full admin: two sub-admins cannot authorize it on their own';
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
  -- [0211] the first approver reviewed this bank recipient (recorded by the
  -- first-approval trigger); a change since then needs a fresh review.
  IF r.payload ? 'recipient_code' AND r.payload->>'recipient_code' IS DISTINCT FROM v_recipient THEN
    RAISE EXCEPTION 'The bank account changed after the first approval; cancel the first approval and review the withdrawal again';
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

  -- [0211] tell the user.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (w.organizer_id, 'sale', 'Withdrawal approved',
          'Your withdrawal of ' || public.withdrawal_naira(w.amount_kobo)
            || ' was approved by two VENTS admins. It will be sent to your bank shortly.',
          false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal', 'request_id', w.id, 'stage', 'approved'));
END;
$function$;

-- One open first approval per withdrawal, checked under the withdrawal's row
-- lock (two admins clicking at once cannot both file one). It records the
-- bank recipient the first approver reviewed.
CREATE OR REPLACE FUNCTION public.authorize_withdrawal_first_approval_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  w public.organizer_withdrawal_requests;
  v_recipient text;
BEGIN
  IF NEW.action_type IS DISTINCT FROM 'authorize_withdrawal' OR NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;
  IF NEW.target_id IS NULL THEN RAISE EXCEPTION 'The first approval must name a withdrawal request'; END IF;
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = NEW.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal request is %, not pending', w.status; END IF;
  IF w.approved_by IS NOT NULL THEN RAISE EXCEPTION 'This withdrawal already has both approvals'; END IF;
  IF w.organizer_id = NEW.requested_by THEN
    RAISE EXCEPTION 'An admin cannot approve their own withdrawal';
  END IF;
  IF public.withdrawal_admin_tier(NEW.requested_by) IS NULL THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF NEW.payload ? 'request_id' AND NEW.payload->>'request_id' IS DISTINCT FROM w.id::text THEN
    RAISE EXCEPTION 'The authorization must name exactly one withdrawal request';
  END IF;
  IF jsonb_typeof(NEW.payload->'amount_kobo') IS DISTINCT FROM 'number'
     OR (NEW.payload->>'amount_kobo')::numeric <> w.amount_kobo THEN
    RAISE EXCEPTION 'The amount reviewed (%) does not match the request (%)', COALESCE(NEW.payload->>'amount_kobo', 'missing'), w.amount_kobo;
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_action_requests q
              WHERE q.action_type = 'authorize_withdrawal' AND q.target_id = w.id AND q.status = 'pending') THEN
    RAISE EXCEPTION 'This withdrawal already has a first approval; a different admin must give the second approval';
  END IF;
  SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b
   WHERE b.id = w.bank_account_id AND b.is_active;
  IF v_recipient IS NULL THEN
    RAISE EXCEPTION 'The withdrawal''s bank account is inactive or has no verified recipient; reject it so the user can request again';
  END IF;
  NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
                 || jsonb_build_object('request_id', w.id, 'recipient_code', v_recipient);
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS authorize_withdrawal_first_approval_check ON public.admin_action_requests;
CREATE TRIGGER authorize_withdrawal_first_approval_check
  BEFORE INSERT ON public.admin_action_requests
  FOR EACH ROW EXECUTE FUNCTION public.authorize_withdrawal_first_approval_check();

-- A first approval still open when its withdrawal is rejected or cancelled
-- is closed, so it never lingers in Admin Actions; the user is told.
CREATE OR REPLACE FUNCTION public.withdrawal_close_open_authorizations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('rejected', 'cancelled') THEN
    UPDATE public.admin_action_requests
       SET status = 'rejected', reviewed_by = COALESCE(auth.uid(), reviewed_by), reviewed_at = now(),
           review_reason = 'Closed automatically: the withdrawal was ' || NEW.status || ' before its second approval',
           seen_at = COALESCE(seen_at, now())
     WHERE action_type = 'authorize_withdrawal' AND target_id = NEW.id AND status = 'pending';
    IF NEW.status = 'rejected' THEN
      INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
      VALUES (NEW.organizer_id, 'sale', 'Withdrawal not approved',
              'Your withdrawal of ' || public.withdrawal_naira(NEW.amount_kobo)
                || ' was not approved and the money is back in your available balance.'
                || COALESCE(' Reason: ' || NULLIF(btrim(NEW.admin_note), ''), ''),
              false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal', 'request_id', NEW.id, 'stage', 'rejected'));
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
DROP TRIGGER IF EXISTS withdrawal_close_open_authorizations ON public.organizer_withdrawal_requests;
CREATE TRIGGER withdrawal_close_open_authorizations
  AFTER UPDATE OF status ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.withdrawal_close_open_authorizations();

-- Dashboard actions (Payouts screen). Any admin; the rules are in the
-- trigger above, execute_withdrawal_authorization and the 0205 guard.
CREATE OR REPLACE FUNCTION public.admin_first_approve_withdrawal(p_request_id uuid, p_amount_kobo bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_label text;
  v_req jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username, 'Withdrawal') || ' · ' || public.withdrawal_naira(r.amount_kobo)
    INTO v_label
    FROM public.organizer_withdrawal_requests r LEFT JOIN public.users u ON u.id = r.organizer_id
   WHERE r.id = p_request_id;
  IF v_label IS NULL THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  v_req := public.request_admin_action('authorize_withdrawal', 'withdrawal', p_request_id, v_label,
                                       jsonb_build_object('request_id', p_request_id, 'amount_kobo', p_amount_kobo));
  RETURN jsonb_build_object('request_id', p_request_id, 'stage', 'pending_second_approval',
                            'approval_request_id', v_req->>'id');
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_approve_withdrawal(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  w public.organizer_withdrawal_requests;
  r public.admin_action_requests;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.approved_by IS NOT NULL THEN RAISE EXCEPTION 'This withdrawal already has both approvals'; END IF;
  IF w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal request is %, not pending', w.status; END IF;
  IF w.organizer_id = v_uid THEN RAISE EXCEPTION 'An admin cannot approve their own withdrawal'; END IF;
  SELECT * INTO r FROM public.admin_action_requests
   WHERE action_type = 'authorize_withdrawal' AND target_id = w.id AND status = 'pending'
   ORDER BY requested_at LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This withdrawal has no first approval yet; give the first approval instead';
  END IF;
  IF r.requested_by = v_uid THEN
    RAISE EXCEPTION 'You gave the first approval; a different admin must give the second';
  END IF;
  PERFORM public.execute_withdrawal_authorization(r.id);
  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = r.id;
  RETURN jsonb_build_object('request_id', w.id, 'stage', 'approved',
                            'first_approved_by', r.requested_by, 'second_approved_by', v_uid);
END;
$function$;

-- Withdraw a first approval (a mistake, or the bank changed): the first
-- approver, or a full admin. The withdrawal goes back to waiting for its
-- first approval; nothing else changes.
CREATE OR REPLACE FUNCTION public.admin_cancel_withdrawal_first_approval(p_request_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  w public.organizer_withdrawal_requests;
  r public.admin_action_requests;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.approved_by IS NOT NULL OR w.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a first approval that still waits for its second approval can be withdrawn';
  END IF;
  SELECT * INTO r FROM public.admin_action_requests
   WHERE action_type = 'authorize_withdrawal' AND target_id = w.id AND status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This withdrawal has no first approval to withdraw'; END IF;
  IF r.requested_by <> v_uid AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Only the admin who gave the first approval, or a full admin, can withdraw it';
  END IF;
  UPDATE public.admin_action_requests
     SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = btrim(p_reason),
         seen_at = COALESCE(seen_at, now())
   WHERE id = r.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_uid, 'withdrawal_first_approval_withdrawn', w.organizer_id,
          jsonb_build_object('request_id', w.id, 'admin_request_id', r.id, 'first_approved_by', r.requested_by,
                             'reason', btrim(p_reason)),
          public.actor_role());
  RETURN jsonb_build_object('request_id', w.id, 'stage', 'pending_first_approval');
END;
$function$;


-- ---------------------------------------------------------------------------
-- 3. One authoritative state for every screen
-- ---------------------------------------------------------------------------
-- Admins and sub-admins get the same rows, stages and approvers; the can_*
-- columns and action_note say what THIS admin may do and why not. The
-- database refuses anything else regardless.
CREATE OR REPLACE FUNCTION public.admin_list_withdrawals(p_scope text DEFAULT 'open', p_limit integer DEFAULT 100)
 RETURNS TABLE(request_id uuid, organizer_id uuid, organizer_name text, organizer_email text, organizer_phone text,
               amount_kobo bigint, status text, stage text,
               bank_name text, account_number text, account_name text, bank_account_active boolean,
               created_at timestamptz, updated_at timestamptz, admin_note text,
               first_approval_id uuid, first_approved_by uuid, first_approved_by_name text, first_approved_by_tier text,
               first_approved_at timestamptz,
               second_approved_by uuid, second_approved_by_name text, second_approved_at timestamptz,
               paystack_reference text, transfer_started boolean,
               can_first_approve boolean, can_second_approve boolean, can_cancel_first_approval boolean,
               can_pay boolean, can_reject boolean, action_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_paused boolean;
  v_full boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('open', 'closed', 'all') THEN
    RAISE EXCEPTION 'scope must be open, closed or all';
  END IF;
  v_paused := public.payouts_disabled();
  v_full := public.is_super_admin();
  RETURN QUERY
  WITH base AS (
    SELECT r.*
      FROM public.organizer_withdrawal_requests r
     WHERE CASE p_scope WHEN 'open' THEN r.status IN ('pending', 'processing')
                        WHEN 'closed' THEN r.status NOT IN ('pending', 'processing')
                        ELSE true END
     ORDER BY CASE WHEN r.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
              CASE WHEN r.status IN ('pending', 'processing') THEN r.created_at END ASC,
              r.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ), x AS (
    SELECT b.*,
           fa.id AS fa_id, fa.requested_by AS fa_by, fa.requested_at AS fa_at, (fa.status = 'pending') AS fa_open,
           ba.is_active AS ba_active, ba.recipient_code AS ba_recipient,
           ou.full_name AS o_name, ou.username AS o_username, ou.email AS o_email, ou.phone_number AS o_phone,
           fu.full_name AS f_name, fu.username AS f_username,
           su.full_name AS s_name, su.username AS s_username
      FROM base b
      LEFT JOIN LATERAL (
        SELECT q.id, q.requested_by, q.requested_at, q.status
          FROM public.admin_action_requests q
         WHERE q.action_type = 'authorize_withdrawal' AND q.target_id = b.id
           AND (q.status = 'pending' OR q.id = b.approval_request_id)
         ORDER BY (q.id = b.approval_request_id) DESC NULLS LAST, q.requested_at DESC
         LIMIT 1) fa ON true
      LEFT JOIN public.organizer_bank_accounts ba ON ba.id = b.bank_account_id
      LEFT JOIN public.users ou ON ou.id = b.organizer_id
      LEFT JOIN public.users fu ON fu.id = COALESCE(b.approval_requested_by, fa.requested_by)
      LEFT JOIN public.users su ON su.id = b.approved_by
  ), y AS (
    SELECT x.*,
           (x.status = 'pending' AND x.approved_by IS NULL AND COALESCE(x.fa_open, false)) AS has_first,
           (COALESCE(x.ba_active, false) AND x.ba_recipient IS NOT NULL) AS bank_ok,
           (x.approved_by IS NOT NULL AND COALESCE(x.ba_active, false) AND x.ba_recipient IS NOT DISTINCT FROM x.approved_recipient_code) AS paid_to_approved
      FROM x
  )
  SELECT y.id, y.organizer_id,
         COALESCE(NULLIF(btrim(y.o_name), ''), y.o_username), y.o_email, y.o_phone,
         y.amount_kobo, y.status,
         public.withdrawal_stage(y.status, y.approved_by, y.has_first),
         COALESCE(y.bank_name, NULL), y.account_number, y.account_name, COALESCE(y.ba_active, false),
         y.created_at, y.updated_at, y.admin_note,
         CASE WHEN y.has_first OR y.approved_by IS NOT NULL THEN y.fa_id END,
         CASE WHEN y.has_first OR y.approved_by IS NOT NULL THEN COALESCE(y.approval_requested_by, y.fa_by) END,
         CASE WHEN y.has_first OR y.approved_by IS NOT NULL THEN COALESCE(NULLIF(btrim(y.f_name), ''), y.f_username) END,
         CASE WHEN y.has_first OR y.approved_by IS NOT NULL THEN public.withdrawal_admin_tier(COALESCE(y.approval_requested_by, y.fa_by)) END,
         CASE WHEN y.has_first OR y.approved_by IS NOT NULL THEN y.fa_at END,
         y.approved_by, COALESCE(NULLIF(btrim(y.s_name), ''), y.s_username), y.approved_at,
         y.paystack_reference, (y.transfer_code IS NOT NULL),
         -- can_first_approve
         (y.status = 'pending' AND y.approved_by IS NULL AND NOT y.has_first AND y.organizer_id <> v_uid AND y.bank_ok),
         -- can_second_approve
         (y.has_first AND y.organizer_id <> v_uid AND y.fa_by <> v_uid
          AND public.withdrawal_approval_allowed(y.fa_by, v_uid)),
         -- can_cancel_first_approval
         (y.has_first AND (y.fa_by = v_uid OR v_full)),
         -- can_pay
         (y.status = 'pending' AND y.approved_by IS NOT NULL AND y.organizer_id <> v_uid AND y.paid_to_approved AND NOT v_paused),
         -- can_reject (admin_reject_organizer_payout: full admins only, as before)
         (y.status = 'pending' AND NOT v_paused AND v_full),
         CASE
           WHEN y.status NOT IN ('pending') THEN NULL
           WHEN y.organizer_id = v_uid THEN 'This is your own withdrawal; two other admins must review it.'
           WHEN v_paused THEN 'Payouts are paused (kill switch): nothing can be approved for payment, paid or rejected until they are resumed.'
           WHEN y.approved_by IS NOT NULL AND NOT y.paid_to_approved
             THEN 'The bank account changed after approval. Reject it so the user can request again.'
           WHEN y.has_first AND y.fa_by = v_uid THEN 'You gave the first approval. A different admin must give the second.'
           WHEN y.has_first AND public.withdrawal_admin_tier(y.fa_by) IS NULL
             THEN 'The first approver is no longer an admin. Withdraw that first approval and review it again.'
           WHEN y.has_first AND NOT public.withdrawal_approval_allowed(y.fa_by, v_uid)
             THEN 'The first approval came from a sub-admin, so the second must come from a full admin.'
           WHEN y.approved_by IS NULL AND NOT y.has_first AND NOT y.bank_ok
             THEN 'The withdrawal''s bank account is no longer active. Reject it so the user can request again.'
         END
    FROM y
   ORDER BY CASE WHEN y.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
            CASE WHEN y.status IN ('pending', 'processing') THEN y.created_at END ASC,
            y.created_at DESC;
END;
$function$;

-- The user's own withdrawals with the same stages (no admin identities).
CREATE OR REPLACE FUNCTION public.get_my_withdrawals(p_limit integer DEFAULT 50)
 RETURNS TABLE(request_id uuid, amount_kobo bigint, status text, stage text, bank_name text,
               account_number_masked text, created_at timestamptz, updated_at timestamptz, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id, r.amount_kobo, r.status,
         public.withdrawal_stage(r.status, r.approved_by,
           EXISTS (SELECT 1 FROM public.admin_action_requests q
                    WHERE q.action_type = 'authorize_withdrawal' AND q.target_id = r.id AND q.status = 'pending')),
         r.bank_name, public.mask_account_number(r.account_number), r.created_at, r.updated_at,
         CASE WHEN r.status IN ('rejected', 'failed', 'cancelled', 'reversed') THEN NULLIF(btrim(r.admin_note), '') END
    FROM public.organizer_withdrawal_requests r
   WHERE r.organizer_id = auth.uid()
   ORDER BY r.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$function$;


-- ---------------------------------------------------------------------------
-- 1. Withdrawal PIN
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.withdrawal_pins (
  user_id          uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  pin_hash         text NOT NULL,
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  lockouts         integer NOT NULL DEFAULT 0 CHECK (lockouts >= 0),
  locked_until     timestamptz,
  must_reset       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  changed_at       timestamptz NOT NULL DEFAULT now(),
  reset_at         timestamptz,
  last_failed_at   timestamptz,
  last_verified_at timestamptz
);
ALTER TABLE public.withdrawal_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.withdrawal_pins FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.withdrawal_pins IS
  'Withdrawal PIN (0211): bcrypt hash bound to the user id, attempt counters. Never readable by clients; only the 0211 functions use it.';

-- Audit trail of PIN events (never the PIN itself).
CREATE TABLE IF NOT EXISTS public.withdrawal_pin_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL,
  event      text NOT NULL CHECK (event IN ('created', 'reset', 'verified', 'failed', 'locked', 'reset_required')),
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawal_pin_events_user_idx ON public.withdrawal_pin_events (user_id, created_at DESC);
ALTER TABLE public.withdrawal_pin_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.withdrawal_pin_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.withdrawal_pin_policy()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object('length', 4, 'max_attempts', 5, 'lock_minutes', 30, 'max_lockouts', 3,
                            'reset_pause_hours', 24, 'min_withdrawal_kobo', 10000);
$function$;

-- Hash and compare with pgcrypto, wherever the extension lives (Supabase:
-- the extensions schema). The user id is part of the hashed text, so a hash
-- copied to another account never matches.
DO $pgcrypto0211$
DECLARE
  v_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  END IF;
  SELECT n.nspname INTO v_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
  EXECUTE format($f$
CREATE OR REPLACE FUNCTION public.withdrawal_pin_hash(p_user uuid, p_pin text)
 RETURNS text
 LANGUAGE sql
 VOLATILE
 SET search_path TO ''
AS $b$
  SELECT %1$I.crypt(p_user::text || ':' || p_pin, %1$I.gen_salt('bf', 10));
$b$;$f$, v_schema);
  EXECUTE format($f$
CREATE OR REPLACE FUNCTION public.withdrawal_pin_matches(p_user uuid, p_pin text, p_hash text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $b$
  SELECT p_hash IS NOT NULL AND p_pin IS NOT NULL AND %1$I.crypt(p_user::text || ':' || p_pin, p_hash) = p_hash;
$b$;$f$, v_schema);
END
$pgcrypto0211$;

CREATE OR REPLACE FUNCTION public.withdrawal_pin_is_weak(p_pin text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_pin ~ '^(.)\1{3}$'                         -- 0000, 1111 ...
      OR p_pin ~ '^(..)\1$'                           -- 1212, 2020 ...
      OR position(p_pin IN '0123456789') > 0          -- 0123, 1234 ...
      OR position(p_pin IN '9876543210') > 0;         -- 4321, 9876 ...
$function$;

CREATE OR REPLACE FUNCTION public.withdrawal_pin_validate(p_pin text, p_pin_confirm text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Your withdrawal PIN must be exactly 4 digits';
  END IF;
  IF p_pin_confirm IS DISTINCT FROM p_pin THEN
    RAISE EXCEPTION 'The two PINs do not match';
  END IF;
  IF public.withdrawal_pin_is_weak(p_pin) THEN
    RAISE EXCEPTION 'That PIN is too easy to guess (like 1111, 1234 or 1212). Choose another';
  END IF;
END;
$function$;

-- The password was entered within the last 5 minutes: the access token's
-- amr claim records when, and a refreshed session keeps the original time.
CREATE OR REPLACE FUNCTION public.withdrawal_password_recently_confirmed()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_amr jsonb;
BEGIN
  BEGIN
    v_amr := auth.jwt() -> 'amr';
  EXCEPTION WHEN others THEN
    v_amr := NULL;
  END;
  IF v_amr IS NULL OR jsonb_typeof(v_amr) <> 'array' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_amr) e
     WHERE jsonb_typeof(e) = 'object'
       AND e->>'method' = 'password'
       AND COALESCE(e->>'timestamp', '') ~ '^[0-9]{1,12}$'
       AND (e->>'timestamp')::bigint >= extract(epoch FROM now())::bigint - 300
       AND (e->>'timestamp')::bigint <= extract(epoch FROM now())::bigint + 60);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_withdrawal_pin_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  p public.withdrawal_pins;
  pol jsonb := public.withdrawal_pin_policy();
  v_pause timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO p FROM public.withdrawal_pins WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_pin', false, 'locked', false, 'locked_until', NULL, 'must_reset', false,
                              'attempts_left', (pol->>'max_attempts')::int, 'withdrawals_paused_until', NULL,
                              'length', (pol->>'length')::int);
  END IF;
  v_pause := p.reset_at + make_interval(hours => (pol->>'reset_pause_hours')::int);
  RETURN jsonb_build_object(
    'has_pin', true,
    'locked', p.must_reset OR COALESCE(p.locked_until > now(), false),
    'locked_until', CASE WHEN p.locked_until > now() THEN p.locked_until END,
    'must_reset', p.must_reset,
    'attempts_left', GREATEST((pol->>'max_attempts')::int - p.failed_attempts, 0),
    'withdrawals_paused_until', CASE WHEN v_pause > now() THEN v_pause END,
    'changed_at', p.changed_at,
    'length', (pol->>'length')::int);
END;
$function$;

-- First PIN: entered twice; email must be verified (as for withdrawals).
CREATE OR REPLACE FUNCTION public.set_my_withdrawal_pin(p_pin text, p_pin_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before creating a withdrawal PIN';
  END IF;
  PERFORM public.withdrawal_pin_validate(p_pin, p_pin_confirm);
  INSERT INTO public.withdrawal_pins (user_id, pin_hash) VALUES (v_uid, public.withdrawal_pin_hash(v_uid, p_pin))
  ON CONFLICT (user_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You already have a withdrawal PIN. To change it, use Change PIN (it asks for your password)';
  END IF;
  INSERT INTO public.withdrawal_pin_events (user_id, event) VALUES (v_uid, 'created');
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (v_uid, 'sale', 'Withdrawal PIN created',
          'You will enter this 4-digit PIN for every withdrawal. VENTS will never ask you for it.',
          false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal_pin', 'event', 'created'));
  RETURN public.get_my_withdrawal_pin_status();
END;
$function$;

-- Change or forgotten PIN: needs the password entered in the last 5
-- minutes (the API confirms it and calls this with the session it gets).
-- New withdrawals then pause for 24 hours, and the user is told.
CREATE OR REPLACE FUNCTION public.reset_my_withdrawal_pin(p_pin text, p_pin_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_had boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.withdrawal_password_recently_confirmed() THEN
    RAISE EXCEPTION 'PASSWORD_CONFIRMATION_REQUIRED';
  END IF;
  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before setting a withdrawal PIN';
  END IF;
  PERFORM public.withdrawal_pin_validate(p_pin, p_pin_confirm);
  SELECT true INTO v_had FROM public.withdrawal_pins WHERE user_id = v_uid FOR UPDATE;
  INSERT INTO public.withdrawal_pins (user_id, pin_hash)
  VALUES (v_uid, public.withdrawal_pin_hash(v_uid, p_pin))
  ON CONFLICT (user_id) DO UPDATE
     SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, lockouts = 0, locked_until = NULL,
         must_reset = false, changed_at = now(), reset_at = now();
  INSERT INTO public.withdrawal_pin_events (user_id, event) VALUES (v_uid, CASE WHEN v_had THEN 'reset' ELSE 'created' END);
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (v_uid, 'sale',
          CASE WHEN v_had THEN 'Withdrawal PIN changed' ELSE 'Withdrawal PIN created' END,
          CASE WHEN v_had
               THEN 'Your withdrawal PIN was changed. For your security, new withdrawals are paused for 24 hours. If you did not do this, change your password and contact VENTS support now.'
               ELSE 'You will enter this 4-digit PIN for every withdrawal. VENTS will never ask you for it.' END,
          false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal_pin', 'event', CASE WHEN v_had THEN 'reset' ELSE 'created' END));
  RETURN public.get_my_withdrawal_pin_status();
END;
$function$;

-- Internal: checks a PIN and records the outcome. Returns a result instead
-- of raising, so its caller can return it and the counters are committed.
CREATE OR REPLACE FUNCTION public.withdrawal_pin_check(p_user uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  p public.withdrawal_pins;
  pol jsonb := public.withdrawal_pin_policy();
  v_max int := (pol->>'max_attempts')::int;
BEGIN
  SELECT * INTO p FROM public.withdrawal_pins WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_not_set',
                              'message', 'Create your withdrawal PIN before you withdraw');
  END IF;
  IF p.must_reset THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_reset_required',
                              'message', 'Your withdrawal PIN is locked after too many wrong attempts. Reset it with your password');
  END IF;
  IF p.locked_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_locked', 'locked_until', p.locked_until,
                              'message', 'Too many wrong PINs. Try again after ' || to_char(p.locked_until AT TIME ZONE 'Africa/Lagos', 'HH24:MI') || ' (Lagos time), or reset your PIN');
  END IF;
  IF p_pin IS NOT NULL AND p_pin ~ '^[0-9]{4}$' AND public.withdrawal_pin_matches(p_user, p_pin, p.pin_hash) THEN
    UPDATE public.withdrawal_pins
       SET failed_attempts = 0, lockouts = 0, locked_until = NULL, last_verified_at = now()
     WHERE user_id = p_user;
    INSERT INTO public.withdrawal_pin_events (user_id, event) VALUES (p_user, 'verified');
    RETURN jsonb_build_object('ok', true);
  END IF;

  p.failed_attempts := p.failed_attempts + 1;
  IF p.failed_attempts >= v_max THEN
    p.lockouts := p.lockouts + 1;
    p.failed_attempts := 0;
    IF p.lockouts >= (pol->>'max_lockouts')::int THEN
      UPDATE public.withdrawal_pins
         SET failed_attempts = 0, lockouts = p.lockouts, locked_until = NULL, must_reset = true, last_failed_at = now()
       WHERE user_id = p_user;
      INSERT INTO public.withdrawal_pin_events (user_id, event, details) VALUES (p_user, 'reset_required', jsonb_build_object('lockouts', p.lockouts));
      INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
      VALUES (p_user, 'sale', 'Withdrawal PIN locked',
              'Your withdrawal PIN was entered wrongly too many times and is locked. Reset it with your password in your wallet. If this was not you, change your password now.',
              false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal_pin', 'event', 'reset_required'));
      RETURN jsonb_build_object('ok', false, 'code', 'pin_reset_required',
                                'message', 'Too many wrong PINs. Your withdrawal PIN is locked: reset it with your password');
    END IF;
    UPDATE public.withdrawal_pins
       SET failed_attempts = 0, lockouts = p.lockouts,
           locked_until = now() + make_interval(mins => (pol->>'lock_minutes')::int), last_failed_at = now()
     WHERE user_id = p_user
     RETURNING locked_until INTO p.locked_until;
    INSERT INTO public.withdrawal_pin_events (user_id, event, details) VALUES (p_user, 'locked', jsonb_build_object('lockouts', p.lockouts));
    RETURN jsonb_build_object('ok', false, 'code', 'pin_locked', 'locked_until', p.locked_until,
                              'message', 'Too many wrong PINs. Withdrawals are locked for ' || (pol->>'lock_minutes') || ' minutes');
  END IF;
  UPDATE public.withdrawal_pins SET failed_attempts = p.failed_attempts, last_failed_at = now() WHERE user_id = p_user;
  INSERT INTO public.withdrawal_pin_events (user_id, event, details) VALUES (p_user, 'failed', jsonb_build_object('attempt', p.failed_attempts));
  RETURN jsonb_build_object('ok', false, 'code', 'wrong_pin', 'attempts_left', v_max - p.failed_attempts,
                            'message', 'Wrong PIN. ' || (v_max - p.failed_attempts) || ' attempt'
                                       || CASE WHEN v_max - p.failed_attempts = 1 THEN '' ELSE 's' END || ' left');
END;
$function$;

-- The only way to request a withdrawal. A wrong PIN, lock, recent reset,
-- too-small amount or accidental duplicate returns {ok:false, code,
-- message} (so the attempt counter is kept); anything request_organizer_payout
-- refuses (insufficient balance, unverified bank, payouts paused) raises.
CREATE OR REPLACE FUNCTION public.request_withdrawal(p_amount_kobo bigint, p_bank_account_id uuid, p_pin text,
                                                     p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_existing uuid;
  v_check jsonb;
  v_reset timestamptz;
  v_pause timestamptz;
  v_id uuid;
  pol jsonb := public.withdrawal_pin_policy();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  -- A retry of a request that already went through returns it (no money moves).
  IF v_key IS NOT NULL THEN
    SELECT r.id INTO v_existing FROM public.organizer_withdrawal_requests r
     WHERE r.organizer_id = v_uid AND r.idempotency_key = v_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'request_id', v_existing, 'replayed', true);
    END IF;
  END IF;

  v_check := public.withdrawal_pin_check(v_uid, p_pin);
  IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN RETURN v_check; END IF;

  SELECT reset_at INTO v_reset FROM public.withdrawal_pins WHERE user_id = v_uid;
  v_pause := v_reset + make_interval(hours => (pol->>'reset_pause_hours')::int);
  IF v_pause > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_recently_reset', 'paused_until', v_pause,
                              'message', 'Your withdrawal PIN was changed recently. For your security, withdrawals resume at '
                                         || to_char(v_pause AT TIME ZONE 'Africa/Lagos', 'DD Mon HH24:MI') || ' (Lagos time)');
  END IF;
  IF p_amount_kobo IS NULL OR p_amount_kobo < (pol->>'min_withdrawal_kobo')::bigint THEN
    RETURN jsonb_build_object('ok', false, 'code', 'amount_too_small',
                              'message', 'The minimum withdrawal is ' || public.withdrawal_naira((pol->>'min_withdrawal_kobo')::bigint));
  END IF;

  -- Serialize this user's requests (the same row request_organizer_payout
  -- locks), then refuse an identical request made moments ago.
  PERFORM 1 FROM public.organizer_wallets WHERE organizer_id = v_uid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.organizer_withdrawal_requests r
              WHERE r.organizer_id = v_uid AND r.amount_kobo = p_amount_kobo AND r.bank_account_id = p_bank_account_id
                AND r.status IN ('pending', 'processing') AND r.created_at > now() - interval '2 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'duplicate_withdrawal',
                              'message', 'You just requested this exact withdrawal. Check your withdrawal history before trying again');
  END IF;

  v_id := public.request_organizer_payout(p_amount_kobo, p_bank_account_id, v_key);

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (v_uid, 'sale', 'Withdrawal requested',
          'Your withdrawal of ' || public.withdrawal_naira(p_amount_kobo)
            || ' is waiting for review by two VENTS admins. You can follow it in your wallet.',
          false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal', 'request_id', v_id, 'stage', 'pending_first_approval'));
  RETURN jsonb_build_object('ok', true, 'request_id', v_id);
END;
$function$;

-- Bank account changes (add / default / remove): the password must have
-- been entered within 5 minutes. [0211] Was: any token issued within 5
-- minutes, which a silently refreshed session also satisfied.
CREATE OR REPLACE FUNCTION public.assert_recent_auth()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  -- [0211] amr password time, not iat
  IF NOT public.withdrawal_password_recently_confirmed() THEN
    RAISE EXCEPTION 'PASSWORD_CONFIRMATION_REQUIRED';
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Clients can no longer skip the PIN by calling the old entry point (every
-- overload, should an old one still exist; 0123 dropped the 2-argument one).
DO $revoke0211$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'request_organizer_payout' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END
$revoke0211$;

REVOKE ALL ON FUNCTION public.withdrawal_admin_tier(uuid), public.withdrawal_approval_allowed(uuid, uuid),
  public.withdrawal_stage(text, uuid, boolean), public.withdrawal_naira(bigint),
  public.authorize_withdrawal_first_approval_check(), public.withdrawal_close_open_authorizations(),
  public.withdrawal_pin_policy(), public.withdrawal_pin_hash(uuid, text), public.withdrawal_pin_matches(uuid, text, text),
  public.withdrawal_pin_is_weak(text), public.withdrawal_pin_validate(text, text),
  public.withdrawal_password_recently_confirmed(), public.withdrawal_pin_check(uuid, text)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.admin_list_withdrawals(text, integer), public.admin_first_approve_withdrawal(uuid, bigint),
  public.admin_approve_withdrawal(uuid), public.admin_cancel_withdrawal_first_approval(uuid, text),
  public.get_my_withdrawals(integer), public.get_my_withdrawal_pin_status(), public.set_my_withdrawal_pin(text, text),
  public.reset_my_withdrawal_pin(text, text), public.request_withdrawal(bigint, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(text, integer), public.admin_first_approve_withdrawal(uuid, bigint),
  public.admin_approve_withdrawal(uuid), public.admin_cancel_withdrawal_first_approval(uuid, text),
  public.get_my_withdrawals(integer), public.get_my_withdrawal_pin_status(), public.set_my_withdrawal_pin(text, text),
  public.reset_my_withdrawal_pin(text, text), public.request_withdrawal(bigint, uuid, text, text)
  TO authenticated;
