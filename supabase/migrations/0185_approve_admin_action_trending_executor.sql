-- Companion fix to 0182_admin_manual_trending_control.sql, deliberately kept
-- as its OWN migration rather than folded into 0182.
--
-- Why not amend 0182 directly: 0182 is already committed and pushed to
-- origin/main (git history, potentially pulled by other branches/clones),
-- so it counts as "shared" even though it has never been applied to any
-- database (confirmed live: public.events has no admin_trending column and
-- public.admin_set_event_trending does not exist). Rewriting a shared
-- migration's content after the fact -- rather than adding a new one -- is
-- exactly the practice this repo's own migration conventions avoid
-- elsewhere (see 0171/0172's header comments splitting the forward fix from
-- the historical backfill as "different kinds of change", and 0183's header
-- explaining why it was rebased as a fresh file instead of editing 0170 in
-- place). 0182's own column/trigger/function definitions are complete and
-- correct as written and need no change; the only gap is in a DIFFERENT
-- function this migration doesn't touch.
--
-- The gap: adminUserEventActions.ts's toggleEventTrending() (src/app/
-- components/admin/adminUserEventActions.ts) submits action_type
-- 'toggle_event_trending' via request_admin_action() whenever the caller
-- isn't a Super Admin -- exactly the same dual-control pattern every other
-- admin_* action already uses. But approve_admin_action()'s CASE has no
-- branch for it (confirmed live via pg_get_functiondef -- neither 0182 nor
-- 0183 add one), so a Sub-Admin's trend/untrend request always errors on
-- approval with "No executor mapped for action_type: toggle_event_trending"
-- and is left permanently stuck at status='pending'. Same bug class 0183
-- already fixed for set_organizer_capability/set_service_provider_capability.
--
-- Based on the VERIFIED LIVE production body of approve_admin_action
-- (re-confirmed this session via pg_get_functiondef against project
-- slrtjxtzhowhwhebjprv, byte-identical to 0183's own file content -- 0183
-- is the only migration that has touched this function since 0170, which
-- was never applied). Every existing branch, the Super-Admin-only check,
-- the self-approval block, the row lock, and the post-CASE UPDATE/
-- admin_logs/notifications statements are copied verbatim from that live
-- body. Only one new branch is inserted.
--
-- Payload handling: REVISED after this audit's own follow-up review found
-- the first draft's COALESCE-to-false fallback could silently turn an
-- intended "enable Trending" request into a no-op/disable on approval,
-- since the fallback is indistinguishable from an explicit `false`. Fixed
-- in both directions at once:
--   1. adminUserEventActions.ts's toggleEventTrending() now sets
--      `payload: { trending: nextTrending }` when it calls submitOrExecute()
--      (it previously set only `previous`/`changes`, which are audit-log
--      display fields the executor never reads).
--   2. This branch now validates payload.trending strictly, matching
--      set_organizer_capability/set_service_provider_capability's existing
--      reject-on-missing-or-malformed convention (not toggle_event_featured's
--      older COALESCE-to-false pattern, which has the identical latent gap --
--      tracked separately, not fixed here, since toggle_event_featured's own
--      client code was not part of this change and fixing it is out of
--      scope for this migration). A missing or non-boolean payload.trending
--      now raises instead of silently defaulting, so a malformed request
--      can never be misapproved as the opposite of what was asked.
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
    WHEN 'toggle_event_featured'  THEN PERFORM public.admin_set_event_featured(
                                      r.target_id,
                                      COALESCE((r.payload->>'featured')::boolean, false),
                                      COALESCE((r.payload->>'duration_days')::integer, 14));
    -- New: strict validation (matches set_organizer_capability/
    -- set_service_provider_capability's pattern above, not
    -- toggle_event_featured's COALESCE-to-false pattern -- see this file's
    -- header comment). A missing or non-boolean payload.trending is
    -- rejected here, before admin_set_event_trending() ever runs, so a
    -- malformed request can never be misapproved as "disable" when the
    -- admin actually asked to "enable" (or vice versa). admin_set_event_trending()
    -- itself still enforces the real security boundary (is_super_admin())
    -- and the eligibility check (not hidden, not deleted, status
    -- live/published) -- this branch only dispatches, once validated.
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
