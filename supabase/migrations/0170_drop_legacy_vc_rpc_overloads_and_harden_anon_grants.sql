-- Audit findings F15/F16 (MASTER_AUDIT.md). NOT YET APPLIED TO PRODUCTION --
-- drafted for review, pending explicit authorization per this audit's
-- constraint against unapproved changes to VC/financial schema.
--
-- F15 (REVISED after finding a live internal caller): two old-signature
-- admin_credit_vents_cents/admin_debit_vents_cents overloads remain live
-- alongside the correct migration-0147 replacements. Both bypass
-- _vc_pool_move() entirely -- the old credit creates VC without debiting
-- the 1,000,000,000 pool; the old debit destroys VC without crediting the
-- pool back. AdminVCScreen.tsx's direct UI path only ever calls the new
-- 5-arg/4-arg signatures -- but approve_admin_action()'s dual-control
-- executor (0092/0093) calls the OLD 3-arg signatures for the
-- 'credit_vents_cents'/'debit_vents_cents' action types. No UI anywhere in
-- src/ actually creates a request of either type (no request_admin_action
-- call site for them), so this path has never fired in production
-- (admin_action_requests has zero rows of either type, confirmed live) --
-- but it is reachable today by any admin account calling request_admin_action
-- directly via RPC, with a second admin's approval, and would silently
-- corrupt the pool if it ever ran. Fixing this requires repointing
-- approve_admin_action's CASE branches at the new signatures, not just
-- dropping the old functions (a bare drop would turn a silent corruption
-- into a loud error instead -- safer, but still leaves the dual-control VC
-- feature broken rather than working).
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
    -- FIXED (was calling the old pool-bypassing 3-arg overloads): now calls
    -- the migration-0147 signatures. p_counts_toward_lifetime defaults to
    -- false (dual-control requests never carried this flag before, so this
    -- preserves prior behavior exactly); p_idempotency_key uses the
    -- request's own id, which is actually an improvement -- it makes a
    -- retried/duplicate approve_admin_action call on the same request
    -- idempotent at the ledger level too, not just at the request-status level.
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason', false, r.id);
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason', r.id);
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

-- Now safe to drop the old overloads: approve_admin_action no longer calls
-- them (just updated above), and AdminVCScreen.tsx's direct UI path never
-- called them either (confirmed earlier). Nothing else in src/ or api/
-- references the 3-arg signatures.
DROP FUNCTION IF EXISTS public.admin_credit_vents_cents(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.admin_debit_vents_cents(uuid, integer, text);

-- F16: three newer VC-economy RPCs (introduced in migration 0147, after the
-- anon-EXECUTE revocation sweep in 0111) were never folded into that sweep,
-- so they still carry Postgres's default EXECUTE-to-PUBLIC grant, making
-- them anon-reachable at the grant layer. None are exploitable -- each
-- checks is_admin_or_root() internally before doing anything -- but this
-- revoke matches the exact rationale 0111 itself documents (unnecessary
-- attack surface, not a live hole). Mirrors 0111's own pattern exactly:
-- REVOKE FROM anon only, never touching authenticated/project_admin.
REVOKE EXECUTE ON FUNCTION public.admin_debit_vents_cents(uuid, integer, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_vc_summary(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_vc_pool_status() FROM anon;
