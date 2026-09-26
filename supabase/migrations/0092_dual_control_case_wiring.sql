-- Batch 1b (3/3) — Complete the maker-checker loop for event featuring,
-- organizer-request decisions, and service-provider KYC decisions.
--
-- THE DEAD-QUEUE BUG (confirmed live before writing this migration). The
-- frontend already submits 'toggle_event_featured' via submitOrExecute()
-- for a Sub-Admin, and request_admin_action accepts it (no allowlist today)
-- -- but live approve_admin_action's CASE has no branch for it, so it can
-- never be approved: RAISE EXCEPTION 'No executor mapped for action_type'
-- on every attempt, forever. Same shape as the 'restore_event' vs
-- 'restore_deleted_event' string mismatch fixed below.
--
-- CRITICAL RECONCILIATION NOTE (see the Batch 1b pre-flight report): TWO
-- branches (claude/admin-console and claude/admin-security-hardening) each
-- independently CREATE OR REPLACE'd approve_admin_action with disjoint new
-- branches -- admin-console added service_provider_kyc_approve/_reject,
-- admin-security-hardening added restore_event/toggle_event_featured/
-- decide_organizer_request/decide_service_provider_request. Applying either
-- file verbatim after the other would silently delete the other's branches.
-- This migration is neither file -- it is the LIVE production body (pulled
-- via pg_get_functiondef immediately before writing this migration, all 17
-- existing WHEN branches reproduced verbatim, byte-for-byte) with the four
-- branches below ADDED, using admin-security-hardening's naming
-- (decide_service_provider_request, payload-carried status) since
-- request_admin_action's own allowlist already reserved that exact name --
-- not admin-console's separate kyc_approve/kyc_reject action types.
--
-- WHY THE EXECUTORS' is_super_admin() GATES DO NOT BLOCK APPROVAL.
-- approve_admin_action runs each executor via PERFORM inside the APPROVING
-- admin's own session. SECURITY DEFINER swaps the executing Postgres role,
-- not auth.uid() (a JWT claim) -- so is_super_admin() inside
-- admin_set_event_featured / admin_decide_organizer_request /
-- admin_decide_service_provider_request evaluates against the approver (an
-- Admin or Root) and passes. Identical to how the pre-existing
-- 'set_user_role' branch has always worked.
--
-- SELF-APPROVAL GUARD, GENERALIZED. admin-console added a self-approval
-- guard scoped only to its two KYC action types; neither branch guarded the
-- organizer path at all. Both are equally sensitive (both grant a real
-- platform capability), so this migration guards BOTH
-- decide_organizer_request and decide_service_provider_request here, in one
-- place, rather than duplicating the check inside each underlying function.
--
-- ORDERING: depends on 0090 (admin_set_event_featured -> is_super_admin())
-- and 0091 (admin_decide_organizer_request, admin_decide_service_provider_
-- request) already having been applied -- both must land before this file,
-- since the branches added below call those functions.

-- ---------------------------------------------------------------------
-- request_admin_action: validate the action type at submit time. Body is
-- otherwise identical to the live definition (same INSERT, same admin_logs
-- write, same return shape) -- only the new IF-NOT-IN allowlist is added.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_target_label text, p_payload jsonb DEFAULT '{}'::jsonb, p_previous_values jsonb DEFAULT NULL::jsonb, p_requested_changes jsonb DEFAULT NULL::jsonb, p_device text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.admin_action_requests;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to submit an action request';
  END IF;

  -- MUST stay in sync with approve_admin_action's CASE below. Anything not
  -- in this list has no executor, so queuing it would create a request that
  -- can never be approved -- rejecting at submit time surfaces the mistake
  -- to the person who made it, immediately, instead of to a different
  -- person at approval time.
  IF p_action_type NOT IN (
    'organizer_verification_approve', 'organizer_verification_reject',
    'hide_event', 'reinstate_event', 'soft_delete_event',
    'restore_deleted_event', 'restore_event',
    'toggle_event_featured',
    'set_user_role', 'suspend_user', 'unsuspend_user',
    'soft_delete_user', 'reinstate_user', 'toggle_user_verified',
    'credit_vents_cents', 'debit_vents_cents',
    'approve_payout', 'reject_payout', 'cancel_payout',
    'decide_organizer_request', 'decide_service_provider_request'
  ) THEN
    RAISE EXCEPTION 'Unknown action_type: % (no executor is mapped for it)', p_action_type;
  END IF;

  INSERT INTO public.admin_action_requests (
    action_type, target_type, target_id, target_label, payload,
    previous_values, requested_changes, requested_by, requested_by_role, device, ip
  ) VALUES (
    p_action_type, p_target_type, p_target_id, p_target_label, COALESCE(p_payload, '{}'::jsonb),
    p_previous_values, p_requested_changes, auth.uid(), public.actor_role(), p_device,
    public.client_ip()
  ) RETURNING * INTO v_row;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_requested',
          CASE WHEN p_target_type = 'user' THEN p_target_id ELSE NULL END,
          jsonb_build_object('request_id', v_row.id, 'action_type', p_action_type,
                             'target_type', p_target_type, 'target_id', p_target_id,
                             'target_label', p_target_label,
                             'device', p_device, 'ip', v_row.ip),
          public.actor_role());

  RETURN to_jsonb(v_row);
END; $function$
;

-- ---------------------------------------------------------------------
-- approve_admin_action: the live 17 branches, verbatim, plus 4 new ones
-- and a self-approval guard for the 2 decision branches.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  -- Self-approval guard, generalized to both decision action types (ported
  -- from admin-console's KYC-scoped version, which only covered
  -- service-provider decisions -- the organizer path had no guard on either
  -- branch). A Sub-Admin who submitted one of these and later approves it
  -- themselves (e.g. after a role change) must not be able to rubber-stamp
  -- their own request.
  IF r.action_type IN ('decide_organizer_request', 'decide_service_provider_request')
     AND r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    -- Alias for the string the dashboard actually submits in one place
    -- (AdminDashboardScreen.tsx:1498 submits 'restore_event', not
    -- 'restore_deleted_event'). Same executor, no behavioral difference --
    -- added so a request already queued as 'restore_event' becomes
    -- approvable instead of permanently stranded.
    WHEN 'restore_event'          THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'suspend_user'           THEN PERFORM public.admin_suspend_user(r.target_id, NULLIF(r.payload->>'banned_until','')::timestamptz, r.payload->>'reason');
    WHEN 'unsuspend_user'         THEN PERFORM public.admin_unsuspend_user(r.target_id);
    WHEN 'soft_delete_user'       THEN PERFORM public.admin_soft_delete_user(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_user'         THEN PERFORM public.admin_reinstate_user(r.target_id);
    WHEN 'toggle_user_verified'   THEN PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    -- New: event featuring dual control (paired with 0090).
    WHEN 'toggle_event_featured'  THEN PERFORM public.admin_set_event_featured(
                                      r.target_id,
                                      COALESCE((r.payload->>'featured')::boolean, false),
                                      COALESCE((r.payload->>'duration_days')::integer, 14));
    -- New: organizer promotion, now one atomic executor instead of the old
    -- two-step client flow (paired with 0091).
    WHEN 'decide_organizer_request' THEN PERFORM public.admin_decide_organizer_request(
                                      (r.payload->>'request_id')::uuid,
                                      COALESCE((r.payload->>'approve')::boolean, false),
                                      r.payload->>'reason');
    -- New: service-provider KYC brought under the same dual control
    -- (paired with 0091). Payload-based status, not separate approve/reject
    -- action types.
    WHEN 'decide_service_provider_request' THEN PERFORM public.admin_decide_service_provider_request(
                                      (r.payload->>'request_id')::uuid,
                                      r.payload->>'status',
                                      r.payload->>'admin_note');
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'target_label', r.target_label, 'reviewer_ip', public.client_ip(),
                             'previous_values', r.previous_values, 'requested_changes', r.requested_changes),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $function$
;

-- Grants restated exactly as confirmed live (has_function_privilege check
-- run immediately before writing this migration): both functions currently
-- grant EXECUTE to anon, authenticated, AND project_admin. Neither source
-- branch's file matched this: admin-security-hardening's 0086 would have
-- dropped anon and project_admin from both; preserved here instead.
REVOKE ALL ON FUNCTION public.request_admin_action(text, text, uuid, text, jsonb, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_admin_action(text, text, uuid, text, jsonb, jsonb, jsonb, text) TO anon, authenticated, project_admin;
REVOKE ALL ON FUNCTION public.approve_admin_action(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_admin_action(uuid) TO anon, authenticated, project_admin;
