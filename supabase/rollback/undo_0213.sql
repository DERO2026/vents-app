-- Undo 0213 (VENTS Admin payout authority and the Admin Payout PIN).
-- Restores 0211's two-admin approval: the 0211 guard, executor, first-approval
-- check, admin_list_withdrawals and get_my_withdrawals (verbatim from
-- 0211_withdrawal_pin_and_two_admin_approval.sql, generated), the old claim's
-- grants, admin_release_payout_claim for any admin, and the user notice text.
--
-- NOT touched: money, wallets, the ledger, withdrawal requests, approvals,
-- admin requests, logs, notifications. KEPT (closed to every client, unused
-- while rolled back): withdrawal_reviews, payout_authorizations,
-- admin_payout_pins, admin_payout_pin_events and the two new columns on
-- organizer_withdrawal_requests, so re-applying 0213 restores the PIN and the
-- audit trail.
--
-- Refuses while a pending withdrawal is approved only by the VENTS Admin
-- (0211 would let any two-admin-era flow pay it without a PIN): pay or reject
-- those first. Run undo_0213 before undo_0212 / undo_0211.
-- Refuses unless the operator confirms: SET vents.rollback_confirm = 'undo-0213';
DO $guard$
DECLARE
  n integer;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0213' THEN
    RAISE EXCEPTION 'undo_0213: set vents.rollback_confirm = ''undo-0213'' to confirm';
  END IF;
  IF to_regprocedure('public.admin_authorize_and_claim_payout(uuid,bigint,text,text)') IS NULL THEN
    RAISE EXCEPTION 'undo_0213: 0213 is not applied';
  END IF;
  IF to_regprocedure('public.admin_list_withdrawals(text,integer,timestamptz,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'undo_0213: 0214 is applied; run undo_0214 first';
  END IF;
  SELECT count(*) INTO n FROM public.organizer_withdrawal_requests
   WHERE status = 'pending' AND approved_by IS NOT NULL AND approval_request_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'undo_0213: % pending withdrawal(s) are approved only by the VENTS Admin; pay or reject them first', n;
  END IF;
END
$guard$;

-- 0203's two-admin constraint. Approvals given by the VENTS Admin alone under
-- 0213 stay as history (never rewritten), so the constraint comes back NOT
-- VALID when such rows exist: it binds every new approval, not the past ones.
ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_approval_parties;
DO $two_admins$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizer_withdrawal_requests WHERE approved_by IS NOT NULL AND approval_requested_by IS NULL) THEN
    ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_two_admins
      CHECK (approved_by IS NULL OR (approval_requested_by IS NOT NULL AND approved_by <> approval_requested_by
                                     AND approved_by <> organizer_id AND approval_requested_by <> organizer_id)) NOT VALID;
  ELSE
    ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_two_admins
      CHECK (approved_by IS NULL OR (approval_requested_by IS NOT NULL AND approved_by <> approval_requested_by
                                     AND approved_by <> organizer_id AND approval_requested_by <> organizer_id));
  END IF;
END
$two_admins$;

-- 0211 (verbatim)
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

-- 0211 (verbatim)
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
REVOKE ALL ON FUNCTION public.execute_withdrawal_authorization(uuid) FROM PUBLIC, anon, authenticated;

-- 0211 (verbatim)
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

DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer);
-- 0211 (verbatim)
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

-- 0211 (verbatim)
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

DO $release$
DECLARE
  v_def text := pg_get_functiondef('public.admin_release_payout_claim(uuid,text)'::regprocedure);
  v_new constant text := 'IF NOT public.is_root() THEN RAISE EXCEPTION ''VENTS Admin access required''; END IF; -- [0213] was is_admin()';
  v_old constant text := 'IF NOT public.is_admin() THEN RAISE EXCEPTION ''Admin access required''; END IF;';
BEGIN
  IF position(v_new IN v_def) > 0 THEN EXECUTE replace(v_def, v_new, v_old); END IF;
END
$release$;

DO $notice$
DECLARE
  v_def text := pg_get_functiondef('public.request_withdrawal(bigint,uuid,text,text)'::regprocedure);
BEGIN
  IF position(' is waiting for review by VENTS. You can follow it in your wallet.''' IN v_def) > 0 THEN
    EXECUTE replace(replace(v_def,
      ' is waiting for review by VENTS. You can follow it in your wallet.''',
      ' is waiting for review by two VENTS admins. You can follow it in your wallet.'''),
      '''stage'', ''pending_review''', '''stage'', ''pending_first_approval''');
  END IF;
END
$notice$;

DROP FUNCTION IF EXISTS public.admin_payout_overview();
DROP FUNCTION IF EXISTS public.admin_authorize_and_claim_payout(uuid, bigint, text, text);
DROP FUNCTION IF EXISTS public.admin_payout_pin_check(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.admin_set_payout_pin(text, text);
DROP FUNCTION IF EXISTS public.admin_payout_pin_status();
DROP FUNCTION IF EXISTS public.admin_payout_pin_is_weak(text);
DROP FUNCTION IF EXISTS public.admin_payout_pin_matches(uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_payout_pin_hash(uuid, text);
DROP FUNCTION IF EXISTS public.admin_approve_withdrawal_for_payment(uuid, bigint, text);
DROP FUNCTION IF EXISTS public.admin_review_withdrawal(uuid, bigint, text, text);
DROP FUNCTION IF EXISTS public.payout_stage(text, uuid, text);
DROP FUNCTION IF EXISTS public.withdrawal_current_review(uuid);
DROP FUNCTION IF EXISTS public.payout_admin_tier(uuid);
DROP FUNCTION IF EXISTS public.admin_payout_pin_policy();
DROP FUNCTION IF EXISTS public.vents_root_user_id();

-- Grants as 0211 left them.
GRANT EXECUTE ON FUNCTION public.admin_first_approve_withdrawal(uuid, bigint), public.admin_approve_withdrawal(uuid),
  public.admin_cancel_withdrawal_first_approval(uuid, text), public.admin_list_withdrawals(text, integer),
  public.get_my_withdrawals(integer) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_list_withdrawals(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated;
DO $pa$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO project_admin';
  END IF;
END
$pa$;
REVOKE ALL ON public.withdrawal_reviews, public.payout_authorizations, public.admin_payout_pins, public.admin_payout_pin_events
  FROM PUBLIC, anon, authenticated;
