-- VENTS AI subscription cancellation lifecycle -- the missing piece
-- identified on inspection: admin_set_ai_entitlement() (0165) already lets
-- Root flip ANY user's entitlement to 'canceled' (safe revocation already
-- exists, just unwired from any API route), but there was no way for a
-- user to cancel their OWN subscription at all.
--
-- This product has no recurring Paystack subscription object -- every
-- purchase (confirm_ai_subscription_payment, 0175) is a one-time charge
-- that grants a fixed period_end; nothing auto-charges again. So there is
-- no future charge to "cancel" in the usual SaaS sense -- cancelling here
-- means the user is choosing to give up their REMAINING access now,
-- immediately, not "stop auto-renewing at period end" (there is no
-- auto-renewal to defer against). That is why this sets status =
-- 'canceled' immediately rather than scheduling a future transition --
-- scheduling one would require widening has_ai_chat_access() and
-- check_and_reserve_ai_usage()'s own status checks to invent a
-- "canceled but still currently valid" state neither function has today,
-- which is exactly the kind of change that could create real billing
-- inconsistency if done without full verification of every call site that
-- reads entitlement status. This migration deliberately does not touch
-- either of those two live gating functions at all.
--
-- Scoped to auth.uid() via the function body itself -- no argument lets a
-- caller act on anyone else's row. Idempotent: calling it again after
-- already-canceled/expired/inactive returns 'already_canceled' rather
-- than raising or double-logging. Logged to admin_logs for the same audit
-- trail every other entitlement write already uses.
CREATE OR REPLACE FUNCTION public.cancel_my_ai_subscription()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ent public.ai_entitlements;
BEGIN
  SELECT * INTO v_ent FROM public.ai_entitlements WHERE user_id = auth.uid() FOR UPDATE;

  IF v_ent IS NULL THEN
    RETURN jsonb_build_object('status', 'no_entitlement');
  END IF;

  IF v_ent.status IN ('canceled', 'inactive', 'expired') THEN
    RETURN jsonb_build_object('status', 'already_canceled', 'plan_id', v_ent.plan_id);
  END IF;

  UPDATE public.ai_entitlements SET status = 'canceled', updated_at = now()
    WHERE user_id = auth.uid();

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'ai_subscription_self_cancelled', auth.uid(),
    jsonb_build_object('plan_id', v_ent.plan_id, 'previous_status', v_ent.status, 'had_period_end', v_ent.period_end),
    'user');

  RETURN jsonb_build_object('status', 'canceled', 'plan_id', v_ent.plan_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_my_ai_subscription() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_my_ai_subscription() TO authenticated;
