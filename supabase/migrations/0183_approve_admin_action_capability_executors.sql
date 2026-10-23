-- Fixes a confirmed production defect found in the Users-section audit:
-- approve_admin_action() has no executor for 'set_organizer_capability' or
-- 'set_service_provider_capability' -- the two action types
-- adminUserEventActions.ts's setOrganizerCapability()/
-- setServiceProviderCapability() actually submit via request_admin_action()
-- when the caller isn't a Super Admin (src/app/components/admin/
-- adminUserEventActions.ts:76-92). Confirmed live against production via
-- pg_get_functiondef('public.approve_admin_action(uuid)'): its CASE has no
-- branch for either action type, so a Sub-Admin's request always errors on
-- approval with "No executor mapped for action_type: ...", leaving the
-- request permanently stuck at status='pending' and the capability never
-- actually granted/revoked -- despite the UI flashing "Request sent --
-- waiting for Admin approval." as if it will eventually succeed.
--
-- This migration is additive only, and based on the VERIFIED LIVE
-- PRODUCTION body (re-pulled fresh for this migration, not reused from an
-- earlier draft): every existing WHEN branch, the Super-Admin-only check,
-- the self-approval block, the row lock, the pending-request guard, and the
-- post-CASE UPDATE/admin_logs/notifications statements are copied verbatim
-- from that live body. Only the two new branches are inserted.
--
-- IMPORTANT: the 'credit_vents_cents'/'debit_vents_cents' branches below are
-- deliberately kept in their CURRENT PRODUCTION 3-arg/2-arg form
-- (admin_credit_vents_cents(target_id, amount, reason) /
-- admin_debit_vents_cents(target_id, amount, reason)), NOT the 5-arg/4-arg
-- form drafted in migration 0170_drop_legacy_vc_rpc_overloads_and_harden_
-- anon_grants.sql. That file's own header states it is "NOT YET APPLIED TO
-- PRODUCTION -- drafted for review, pending explicit authorization per this
-- audit's constraint against unapproved changes to VC/financial schema",
-- and a live pg_proc check confirms both the old and new
-- admin_credit_vents_cents/admin_debit_vents_cents overloads still coexist
-- in production today -- i.e. 0170 has not been applied. An earlier draft
-- of this migration was based on 0170's file body instead of the live
-- function, which would have silently smuggled 0170's unauthorized VC
-- signature change in as a side effect of this unrelated capability-
-- executor fix. This migration does not do that: it changes nothing about
-- credit_vents_cents/debit_vents_cents, and does not apply, bundle, or
-- change the authorization status of 0170 in any way. That VC/financial
-- reconciliation remains a separate, not-yet-authorized piece of work.
--
-- Payload validation (reject missing/malformed booleans safely, never
-- silently coerce): request_admin_action() stores p_payload as opaque
-- jsonb with no schema validation of its own, so a malformed or missing
-- payload is only caught here, at execution time. `payload->>'key'`
-- extracts the literal text 'true' or 'false' for a well-formed boolean
-- payload; anything else (missing key -> SQL NULL, a typo, a string, a
-- number) is explicitly rejected via comparison against that known pair
-- before the cast runs, rather than letting
-- `(payload->>'is_organizer')::boolean` either silently produce NULL (for
-- a missing key, which casts to NULL without error) or throw a generic,
-- context-free Postgres cast error. A rejected request raises and is left
-- exactly where every other failed CASE branch already leaves it: at
-- status='pending', since the status UPDATE after the CASE never runs when
-- any branch raises -- no new rollback/retry logic was needed, this
-- migration just makes capability requests fail the same way every other
-- action type already does.
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
    -- New: mirrors toggle_user_verified's shape, but with an explicit
    -- allowlist check before the cast instead of casting straight from the
    -- extracted text -- a missing payload key extracts as NULL, which is
    -- not in ('true','false') and is rejected here rather than silently
    -- reaching admin_set_organizer_capability()/
    -- admin_set_service_provider_capability() with a NULL p_enabled.
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
    -- Kept exactly as in current production -- NOT migration 0170's 5-arg/
    -- 4-arg form. See this file's header comment.
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
END; $function$;
