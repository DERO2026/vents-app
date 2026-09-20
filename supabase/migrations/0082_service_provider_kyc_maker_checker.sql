-- ── Service Provider KYC maker-checker hardening ────────────────────────────
--
-- SECURITY FIX: an independent review found admin_decide_service_provider_request
-- (0044_service_provider_kyc.sql) gated only on is_admin_or_root(). That helper
-- is itself defined as `SELECT public.is_super_admin();` (0004_functions.sql),
-- i.e. Root OR role = 'admin' -- it does NOT admit 'sub-admin' today. However,
-- both call sites (AdminDashboardScreen.tsx's services-admin tab and
-- AdminProviderDetail.tsx) show the Approve/Reject buttons to every admin tier
-- unconditionally and call the RPC directly with no maker-checker fallback --
-- so a Sub-Admin's click either (a) already fails hard against the DB's
-- Root/Admin-only gate with a raw error and no way to proceed, or (b) would
-- succeed directly the moment is_admin_or_root()/is_super_admin() is ever
-- broadened, since nothing in the RPC or the UI enforces the intended
-- maker-checker split independently of that one shared helper. Neither
-- outcome matches the intended policy:
--   - Root: direct approve/reject.
--   - Admin: direct approve/reject.
--   - Sub-Admin: must submit for Admin/Root approval; cannot decide directly,
--     and cannot approve their own submitted request.
--
-- This migration:
--   1. Re-points admin_decide_service_provider_request's role check at
--      is_super_admin() directly (rather than the indirection through
--      is_admin_or_root()), so a direct call is Root+Admin only regardless of
--      how is_admin_or_root() is defined elsewhere or redefined later --
--      belt-and-suspenders on top of the fact that is_super_admin() already
--      excludes sub-admin. The function body is otherwise byte-identical to
--      0044's version (same atomic request-update + capability-grant +
--      notification + admin_logs write).
--   2. Extends approve_admin_action's dispatcher (0004_functions.sql) with two
--      new action types, service_provider_kyc_approve/_reject, so a
--      Sub-Admin's submission goes through the SAME generic
--      request_admin_action / approve_admin_action / reject_admin_action
--      machinery already used for organizer verification, user role changes,
--      event moderation, and payouts -- no new table, no parallel approval
--      flow. The approval branch re-derives and executes the decision
--      server-side from the request row's own stored payload (request id +
--      reason), never from anything the approving admin's client sends beyond
--      "approve this specific already-stored request id" -- so a client can't
--      relabel or redirect what gets executed at approval time.
--   3. Adds a targeted self-approval guard for these two action types only
--      (approve_admin_action has no generic self-approval check for ANY
--      action type today -- see report -- so this is scoped narrowly to KYC
--      rather than changing behavior for the other action types already
--      dispatched by this function).
--
-- Every other action type's CASE branch below is copied verbatim from the
-- live 0004_functions.sql definition of approve_admin_action -- nothing about
-- their behavior changes.

-- ── admin_decide_service_provider_request: tightened role check ────────────
CREATE OR REPLACE FUNCTION public.admin_decide_service_provider_request(p_request_id uuid, p_status text, p_admin_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_business text; v_type text;
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'status must be ''approved'' or ''rejected''';
  END IF;

  SELECT user_id, business_name, provider_type INTO v_user_id, v_business, v_type
  FROM public.service_provider_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.service_provider_requests
  SET status = p_status, admin_note = p_admin_note, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;

  IF p_status = 'approved' THEN
    UPDATE public.users SET is_service_provider = true WHERE id = v_user_id;
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_user_id, 'promo', 'Provider Application Approved ✓',
      'You''re approved as a Service Provider on Vents. Set up your services listing to go live.',
      false, '🛠️'
    );
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_user_id, 'promo', 'Provider Application Update',
      COALESCE('Your Service Provider application was not approved: ' || p_admin_note, 'Your Service Provider application was not approved.'),
      false, 'ℹ️'
    );
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'service_provider_request_decision', v_user_id, jsonb_build_object('request_id', p_request_id, 'status', p_status), public.actor_role());
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) TO authenticated, project_admin;

-- ── approve_admin_action: dispatch the new provider-KYC action types ───────
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

  IF r.action_type IN ('service_provider_kyc_approve', 'service_provider_kyc_reject')
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
    WHEN 'service_provider_kyc_approve' THEN PERFORM public.admin_decide_service_provider_request((r.payload->>'request_id')::uuid, 'approved', r.payload->>'reason');
    WHEN 'service_provider_kyc_reject'  THEN PERFORM public.admin_decide_service_provider_request((r.payload->>'request_id')::uuid, 'rejected', r.payload->>'reason');
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

REVOKE ALL ON FUNCTION public.approve_admin_action(p_request_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.approve_admin_action(p_request_id uuid) TO anon, authenticated, project_admin;
