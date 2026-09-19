-- P0-3 / P0-6 / P0-7 — Complete the maker-checker loop.
--
-- THE DEAD-QUEUE BUG. approve_admin_action's CASE ends in
--   ELSE RAISE EXCEPTION 'No executor mapped for action_type: %'
-- and the frontend submits two action types that had NO branch:
--
--   'toggle_event_featured'  (AdminDashboardScreen.tsx:1587)
--   'restore_event'          (AdminDashboardScreen.tsx:1498)
--
-- 'restore_event' is a plain string mismatch — the executor exists and the
-- branch is spelled 'restore_deleted_event'. Both meant that a Sub-Admin's
-- submission was accepted by request_admin_action, stored as 'pending',
-- shown in the Actions queue — and then threw on EVERY approval attempt,
-- forever. The request could only ever be rejected.
--
-- CONTRIBUTING CAUSE, also fixed here: request_admin_action accepted any
-- p_action_type string whatsoever. Nothing validated that an executor
-- existed, so the failure surfaced only at approval time, to a different
-- person, long after the submission. Validation now happens at SUBMIT time.
--
-- ORDERING NOTE: this migration must come after 0082 (which tightened
-- admin_set_event_featured to is_super_admin()) and 0085 (which creates
-- admin_decide_organizer_request). 0082 deliberately blocked the direct
-- Sub-Admin path; without the 'toggle_event_featured' branch added here,
-- Sub-Admins would be blocked at BOTH ends. These land together.
--
-- WHY THE EXECUTORS' is_super_admin() GATES DO NOT BLOCK APPROVAL.
-- approve_admin_action runs each executor via PERFORM inside the APPROVING
-- admin's session. SECURITY DEFINER swaps the executing ROLE, not
-- auth.uid() (a JWT claim), so is_super_admin() inside
-- admin_set_event_featured / admin_decide_organizer_request evaluates
-- against the approver — an Admin or Root — and passes. This is exactly
-- how the pre-existing 'set_user_role' branch already works
-- (admin_set_user_role has been is_super_admin()-gated since 0004).
-- Root keeps its existing blanket bypass because is_root() short-circuits
-- is_super_admin()/is_admin() everywhere, unchanged by this pass.

-- ---------------------------------------------------------------------
-- request_admin_action: validate the action type at submit time.
-- Body is otherwise identical to 0004 (same INSERT, same admin_logs write,
-- same return shape).
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
  -- can never be approved. Rejecting at submit time surfaces the mistake to
  -- the person who made it, immediately.
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
-- approve_admin_action: same body as 0004, with four CASE branches added.
-- The 17 pre-existing branches are reproduced verbatim.
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

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    -- Alias for the string the dashboard actually submitted. The frontend
    -- is corrected to send 'restore_deleted_event', but this branch stays
    -- so that requests ALREADY sitting in the queue as 'restore_event' —
    -- which until now could never be approved — become approvable instead
    -- of being stranded. Same executor, no behavioral difference.
    WHEN 'restore_event'          THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    -- P0-3: the missing branch. Duration defaults to 14 days, matching the
    -- direct path in handleToggleFeatured; unfeaturing ignores it entirely.
    WHEN 'toggle_event_featured'  THEN PERFORM public.admin_set_event_featured(
                                      r.target_id,
                                      COALESCE((r.payload->>'featured')::boolean, false),
                                      COALESCE((r.payload->>'duration_days')::integer, 14));
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
    -- P0-6: organizer promotion, now one atomic executor instead of the old
    -- two-step client flow.
    WHEN 'decide_organizer_request' THEN PERFORM public.admin_decide_organizer_request(
                                      (r.payload->>'request_id')::uuid,
                                      COALESCE((r.payload->>'approve')::boolean, false),
                                      r.payload->>'reason');
    -- P0-7: service provider KYC brought under the same dual control.
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

-- Grants restated unchanged from 0011 — both remain authenticated-callable,
-- with the in-body is_admin()/is_super_admin() checks doing the gating.
REVOKE ALL ON FUNCTION public.request_admin_action(text, text, uuid, text, jsonb, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_admin_action(text, text, uuid, text, jsonb, jsonb, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.approve_admin_action(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_admin_action(uuid) TO authenticated;
