-- ── Complete the maker-checker workflow (backend enforcement) ────────────────
-- 1) Re-gate the general admin RPCs so Sub-Admins CANNOT execute them directly
--    (they must go through request_admin_action → approval). Admins + Root keep
--    direct execution. Achieved by pointing is_admin_or_root() back at the
--    elevated tier (is_super_admin = Root OR full Admin). This re-gates all ~18
--    RPCs that reference it in one change.
-- 2) Add Super-Admin-gated RPCs for the user-moderation actions that previously
--    ran as direct table updates (suspend / unsuspend / soft-delete / reinstate),
--    so those are enforced + auditable + dispatchable on approval too.
-- 3) Expand approve_admin_action to dispatch EVERY action type.
-- 4) On approve/reject, notify the requesting Sub-Admin in-app.

-- ── 1) Re-gate ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin_or_root()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
  SELECT public.is_super_admin();
$fn$;
ALTER FUNCTION public.is_admin_or_root() SET search_path = '';

-- ── 2) User-moderation RPCs (Super Admin only; Root-immutable; audited) ───────
CREATE OR REPLACE FUNCTION public.admin_suspend_user(p_user_id uuid, p_banned_until timestamptz, p_reason text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none'); END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be suspended'; END IF;
  UPDATE public.users SET status = 'suspended', banned_until = p_banned_until WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'suspend_user', p_user_id, jsonb_build_object('banned_until', p_banned_until, 'reason', p_reason), public.actor_role());
END; $fn$;

CREATE OR REPLACE FUNCTION public.admin_unsuspend_user(p_user_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.users SET status = 'active', banned_until = NULL WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'unsuspend_user', p_user_id, '{}'::jsonb, public.actor_role());
END; $fn$;

CREATE OR REPLACE FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be deleted'; END IF;
  UPDATE public.users SET status = 'deleted', deleted_at = now(), deleted_by = auth.uid(), reason = p_reason WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'delete_user', p_user_id, jsonb_build_object('reason', p_reason), public.actor_role());
END; $fn$;

CREATE OR REPLACE FUNCTION public.admin_reinstate_user(p_user_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.users SET status = 'active', banned_until = NULL, deleted_at = NULL, deleted_by = NULL, reason = NULL WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reinstate_user', p_user_id, '{}'::jsonb, public.actor_role());
END; $fn$;

-- ── 3) + 4) Dispatch every action + notify the requester ─────────────────────
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
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
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by, 'target_label', r.target_label), public.actor_role());

  -- Notify the requesting Sub-Admin.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'admin_action', 'Request approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $fn$;

CREATE OR REPLACE FUNCTION public.reject_admin_action(p_request_id uuid, p_reason text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  UPDATE public.admin_action_requests
     SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_reason = p_reason, seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_rejected', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by, 'reason', p_reason, 'target_label', r.target_label), public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'admin_action', 'Request rejected',
          format('Your request (%s) was rejected.%s', COALESCE(r.target_label, r.action_type),
                 CASE WHEN p_reason IS NOT NULL AND p_reason <> '' THEN ' Reason: ' || p_reason ELSE '' END), false, '❌');

  RETURN to_jsonb(r);
END; $fn$;
