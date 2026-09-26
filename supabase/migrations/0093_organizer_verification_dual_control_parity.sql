-- A1/A2 from the Batch-2 production audit: organizer/brand verification
-- approve-reject is a fourth maker-checker flow, structurally identical to
-- event-featuring/organizer-request/service-provider-KYC (0090-0092), but
-- was wired into the same admin_action_requests queue in 0092 without
-- getting the same two hardening passes those three flows already have.
--
-- A1 (self-approval bypass): approve_admin_action's self-approval guard
-- only lists 'decide_organizer_request'/'decide_service_provider_request'.
-- 'organizer_verification_approve'/'_reject' dispatch through the same CASE
-- but are excluded from that guard, and the underlying functions
-- (admin_approve_organizer_verification/admin_reject_organizer_verification)
-- only check is_admin_or_root() -- never that the target isn't the caller.
-- An Admin/Root (or a Sub-Admin who files their own verification request
-- and is later promoted) can grant themselves the "Brand Verified" badge.
--
-- A2 (non-atomic double-decision race): both functions do a plain
-- `SELECT ... WHERE status = 'pending'` followed by a SEPARATE
-- `UPDATE ... WHERE id = p_request_id` with no `AND status = 'pending'`
-- re-check and no row lock -- unlike the atomic
-- `UPDATE ... WHERE status = 'pending' RETURNING` pattern 0091 already
-- applied to admin_decide_organizer_request/admin_decide_service_provider_
-- request. Two concurrent approve/reject calls on the same request can
-- both pass the initial SELECT and both write, double-firing notifications
-- and admin_logs entries.
--
-- Bodies below are the LIVE production definitions (pulled via
-- pg_get_functiondef immediately before writing this migration) with:
--   - the two organizer-verification functions rewritten to the same
--     atomic check-and-claim shape 0091 established, plus a new
--     self-target guard (mirrors the pattern already used elsewhere: a
--     caller cannot action their own row) -- everything else (notification
--     bodies, admin_logs payload shape, is_admin_or_root() gate, the
--     required-rejection-reason check) is untouched.
--   - approve_admin_action's self-approval IN(...) list extended to also
--     cover 'organizer_verification_approve'/'organizer_verification_reject'.
--     All 21 existing CASE branches are reproduced verbatim, byte-for-byte,
--     per this session's own standing rule: never let a migration silently
--     drop an existing branch.

CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_company text; v_type text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;

  -- Atomic claim: status = 'pending' asserted IN the UPDATE (was a separate
  -- SELECT ... then UPDATE with no re-check), so exactly one concurrent
  -- caller can ever win the race -- same idempotency pattern as
  -- admin_decide_organizer_request/admin_decide_service_provider_request.
  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING user_id, company_name, organizer_type INTO v_user_id, v_company, v_type;

  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  -- Self-approval guard: a caller (Admin/Root, or a Sub-Admin promoted
  -- after filing their own request) cannot approve their own verification.
  -- The row is already claimed atomically above, so this rejects rather
  -- than leaving the request silently stuck -- the caller (or another
  -- admin) can still act on it via the normal dual-control queue, just not
  -- self-serve it directly.
  IF v_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot approve your own verification request';
  END IF;

  UPDATE public.users SET is_verified = true WHERE id = v_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_user_id, 'promo', 'Brand Verified ✓',
    CASE WHEN v_type = 'individual'
      THEN 'You have been verified. Your verified badge is now live across Vents.'
      ELSE COALESCE(v_company, 'Your organization') || ' has been verified. Your verified badge is now live across Vents.'
    END,
    false, '🛡️'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'approve_organizer_verification', v_user_id, jsonb_build_object('request_id', p_request_id), public.actor_role());
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;

  -- Atomic claim, same reasoning as the approve function above.
  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING user_id INTO v_user_id;

  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  IF v_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot reject your own verification request';
  END IF;

  -- In-app notification (Task 7) — includes the reason and invites resubmission.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_user_id, 'promo', 'Verification Not Approved',
          'Your brand verification request was not approved. Reason: ' || p_reason ||
          ' — you can correct the issue and submit a new request.',
          false, '⚠️');

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END; $function$
;

-- Grants restated exactly as confirmed live (has_function_privilege check
-- run immediately before writing this migration): anon, authenticated, AND
-- project_admin all currently have EXECUTE on both functions -- preserved
-- unchanged (the in-body is_admin_or_root() gate, now plus the self-target
-- guard, is what actually restricts these; narrowing the grant is out of
-- scope for this fix).
REVOKE ALL ON FUNCTION public.admin_approve_organizer_verification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_approve_organizer_verification(uuid) TO anon, authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_reject_organizer_verification(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_verification(uuid, text) TO anon, authenticated, project_admin;

-- ---------------------------------------------------------------------
-- approve_admin_action: the live 21 branches, verbatim, with the
-- self-approval guard extended to also cover the two organizer-
-- verification action types.
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

  IF r.action_type IN (
    'decide_organizer_request', 'decide_service_provider_request',
    'organizer_verification_approve', 'organizer_verification_reject'
  ) AND r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
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
    WHEN 'toggle_event_featured'  THEN PERFORM public.admin_set_event_featured(
                                      r.target_id,
                                      COALESCE((r.payload->>'featured')::boolean, false),
                                      COALESCE((r.payload->>'duration_days')::integer, 14));
    WHEN 'decide_organizer_request' THEN PERFORM public.admin_decide_organizer_request(
                                      (r.payload->>'request_id')::uuid,
                                      COALESCE((r.payload->>'approve')::boolean, false),
                                      r.payload->>'reason');
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

-- Grants restated exactly as confirmed live: anon, authenticated, project_admin.
REVOKE ALL ON FUNCTION public.approve_admin_action(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_admin_action(uuid) TO anon, authenticated, project_admin;
