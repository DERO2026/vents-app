-- Fix confirmed production issue #2 (separate change from #1's
-- 0094_fix_self_reinstatement_bypass.sql, per explicit instruction to keep
-- each security fix independently reviewable/revertable):
--
-- approve_admin_action()'s self-approval guard was an ALLOW-LIST covering
-- only 4 of ~20 action_types dispatched by its CASE statement:
--
--   IF r.action_type IN (
--     'decide_organizer_request', 'decide_service_provider_request',
--     'organizer_verification_approve', 'organizer_verification_reject'
--   ) AND r.requested_by = auth.uid() THEN RAISE EXCEPTION ...
--
-- Every other branch -- credit_vents_cents, debit_vents_cents,
-- set_user_role, suspend_user, unsuspend_user, soft_delete_user,
-- reinstate_user, toggle_user_verified, approve_payout, reject_payout,
-- cancel_payout, hide_event, reinstate_event, soft_delete_event,
-- restore_deleted_event/restore_event, toggle_event_featured -- had no
-- self-approval check in this function at all. A single role='admin'
-- account satisfies both is_admin() (submit) and is_super_admin()
-- (approve), so that one account could submit AND approve its own request
-- for any of those action types, defeating the entire dual-control queue
-- for them. Concretely: submit request_admin_action('credit_vents_cents',
-- target=self, ...) then immediately approve_admin_action(request_id) in
-- the same session -- self-minting Vents Cents, logged as an ordinary
-- "approved request" rather than flagged as self-dealing.
--
-- admin_credit_vents_cents/admin_debit_vents_cents additionally had NO
-- self-target restriction anywhere, unlike admin_suspend_user/
-- admin_soft_delete_user which already do `IF p_user_id = auth.uid() THEN
-- RAISE EXCEPTION`. That means even calling them directly (bypassing the
-- queue entirely, which any admin can do since they're SECURITY DEFINER
-- and granted to authenticated) had no self-target protection at all.
--
-- Fix, in two independent layers (defense-in-depth, matching the pattern
-- admin_suspend_user/admin_soft_delete_user already established):
--
--   1. approve_admin_action: replace the 4-item allow-list with a
--      default-deny -- ANY action_type is blocked from self-approval.
--      There is no action_type for which "the same admin who requested
--      this also approved it" is a legitimate dual-control outcome; the
--      previous allow-list only reflected which action types had been
--      hardened so far; this closes the whole surface at once.
--
--   2. admin_credit_vents_cents / admin_debit_vents_cents: add an explicit
--      `p_user_id <> auth.uid()` guard inside each function body, so a
--      direct RPC call (not routed through the queue at all) can't be used
--      to self-credit/self-debit either.
--
-- Nothing else changes: request_admin_action's allowlist, the executor
-- dispatch CASE, audit logging, and every other admin_* function are
-- untouched.

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

  -- Default-deny: no action_type may be approved by the same account that
  -- requested it. Previously only 4 of ~20 action_types were covered here.
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

CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot credit your own Vents Cents balance';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.vents_wallets (user_id, balance)
  VALUES (p_user_id, p_amount::integer)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.vents_wallets.balance + p_amount::integer, updated_at = now();

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_credit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'Admin debit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot debit your own Vents Cents balance';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  PERFORM public._vc_deduct(p_user_id, p_amount, p_reason);

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_debit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('debited', p_amount, 'target_balance', v_balance);
END;
$function$;
