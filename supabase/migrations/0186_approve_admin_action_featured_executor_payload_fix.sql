-- Companion fix to 0185_approve_admin_action_trending_executor.sql, same bug
-- class, different action type. NOT YET APPLIED TO PRODUCTION -- drafted for
-- review, pending explicit authorization, and specifically NOT applied in
-- this task (local-repository-only work).
--
-- The gap: toggleEventFeatured() (src/app/components/admin/
-- adminUserEventActions.ts) never set a `payload` key when submitting a
-- Sub-Admin request via request_admin_action() -- only `previous`/`changes`,
-- which are audit-log display fields the executor never reads. The LIVE
-- approve_admin_action's 'toggle_event_featured' branch (introduced in
-- 0183_approve_admin_action_capability_executors.sql, confirmed live via
-- pg_get_functiondef and unchanged by 0185) is:
--   PERFORM public.admin_set_event_featured(r.target_id,
--     COALESCE((r.payload->>'featured')::boolean, false),
--     COALESCE((r.payload->>'duration_days')::integer, 14));
-- Since payload was always {}, (r.payload->>'featured')::boolean was always
-- NULL, and COALESCE(..., false) silently resolved every approved request
-- to featured=false -- an admin's "enable Featured" click could be approved
-- as a no-op/disable. Exactly the bug already found and fixed for
-- toggle_event_trending in 0185; this is the same fix applied to this one
-- remaining branch.
--
-- Fixed on both ends, mirroring 0185's own fix exactly:
--   1. toggleEventFeatured() now sets `payload: { featured: nextFeatured,
--      duration_days: nextFeatured ? 14 : null }`.
--   2. This branch now validates payload.featured strictly (reject missing
--      or non-boolean), matching set_organizer_capability/
--      set_service_provider_capability/toggle_event_trending's pattern.
--      duration_days is NOT strictly validated -- unlike the boolean
--      enable/disable flag, a missing/malformed duration_days has no
--      "silently does the opposite of what was asked" failure mode, only a
--      "falls back to the product default of 14 days" one, which is a
--      reasonable default, not a correctness inversion. COALESCE(..., 14)
--      is kept for that field alone.
--
-- Based on the VERIFIED LIVE production body of approve_admin_action as of
-- this session's last direct pg_get_functiondef read (byte-identical to
-- 0183's file content for every branch except the one 0185 already changed
-- for toggle_event_trending). Every existing branch, the Super-Admin-only
-- check, the self-approval block, the row lock, and the post-CASE UPDATE/
-- admin_logs/notifications statements are copied verbatim. Only the
-- 'toggle_event_featured' branch's validation changes.
--
-- Ordering: this migration must be applied strictly after 0185 (not
-- combined with it) -- 0185 is a separate, already-reviewed, already-
-- pending production change for a different action type, and bundling an
-- unrelated fix into it after the fact would reopen a review that already
-- concluded. This mirrors the same "don't combine different kinds of
-- change" convention already used for 0171/0172 and for keeping this fix
-- out of 0182/0185 in the first place.
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

  IF r.requested_by = auth.uid() THEN
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
    WHEN 'set_organizer_capability' THEN
      IF r.payload->>'is_organizer' IS NULL OR r.payload->>'is_organizer' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'set_organizer_capability requires a boolean payload.is_organizer (got: %)', r.payload->>'is_organizer';
      END IF;
      PERFORM public.admin_set_organizer_capability(r.target_id, (r.payload->>'is_organizer')::boolean);
    WHEN 'set_service_provider_capability' THEN
      IF r.payload->>'is_service_provider' IS NULL OR r.payload->>'is_service_provider' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'set_service_provider_capability requires a boolean payload.is_service_provider (got: %)', r.payload->>'is_service_provider';
      END IF;
      PERFORM public.admin_set_service_provider_capability(r.target_id, (r.payload->>'is_service_provider')::boolean);
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    -- New: strict validation for the boolean flag only (see this file's
    -- header comment for why duration_days keeps its COALESCE default).
    WHEN 'toggle_event_featured'  THEN
      IF r.payload->>'featured' IS NULL OR r.payload->>'featured' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'toggle_event_featured requires a boolean payload.featured (got: %)', r.payload->>'featured';
      END IF;
      PERFORM public.admin_set_event_featured(
        r.target_id,
        (r.payload->>'featured')::boolean,
        COALESCE((r.payload->>'duration_days')::integer, 14));
    WHEN 'toggle_event_trending' THEN
      IF r.payload->>'trending' IS NULL OR r.payload->>'trending' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'toggle_event_trending requires a boolean payload.trending (got: %)', r.payload->>'trending';
      END IF;
      PERFORM public.admin_set_event_trending(r.target_id, (r.payload->>'trending')::boolean);
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
END; $function$;
