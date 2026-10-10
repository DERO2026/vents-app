-- VENTS AI subscription payments -- adds real NGN pricing to ai_plans
-- (0165_ai_subscription_foundation.sql) and a Paystack-backed purchase
-- path, reusing the EXACT same create-pending/verify-with-Paystack/
-- confirm-server-side pattern already used by ticket purchases, wallet
-- deposits, and service bookings (see api/webhook/paystack.ts and e.g.
-- 0065_user_wallets.sql's confirm_wallet_deposit). No new serverless
-- function: api/webhook/paystack.ts already multiplexes several unrelated
-- verify flows behind one file specifically because this project's Vercel
-- Hobby plan caps at 12 serverless functions and is already at that cap
-- (see that file's own header comment, PR #6) -- this adds one more
-- reference-prefix branch ('aisub_') to the same file instead of a new one.
--
-- Pricing: exactly the two explicitly-approved NGN prices --
--   VENTS AI:  ₦7,500/month  (750000 kobo)
--   VENTS AI+: ₦13,500/month (1350000 kobo)
-- VENTS AI Pro has NO approved price -- left purchasable=false with
-- price_kobo NULL, deliberately unpublished. The trial plan is also
-- purchasable=false: it is granted via start_ai_trial(), never bought.
-- Nothing here changes app_config.ai_entitlement_enforced (still false in
-- production) or any RLS policy on an existing table.

-- ── 1) Real pricing columns on ai_plans ──────────────────────────────────
ALTER TABLE public.ai_plans
  ADD COLUMN IF NOT EXISTS price_kobo integer CHECK (price_kobo IS NULL OR price_kobo > 0),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'NGN',
  ADD COLUMN IF NOT EXISTS billing_period_days integer CHECK (billing_period_days IS NULL OR billing_period_days > 0),
  -- Separate from `active` (0165's own "is this plan configuration valid"
  -- flag): `purchasable` is "can a user buy this right now". A plan can be
  -- active (usable by an existing/admin-granted entitlement) without being
  -- purchasable (ai_pro: no approved price yet; trial: never bought).
  ADD COLUMN IF NOT EXISTS purchasable boolean NOT NULL DEFAULT false;

UPDATE public.ai_plans SET price_kobo = 750000, currency = 'NGN', billing_period_days = 30, purchasable = true WHERE plan_id = 'ai';
UPDATE public.ai_plans SET price_kobo = 1350000, currency = 'NGN', billing_period_days = 30, purchasable = true WHERE plan_id = 'ai_plus';
-- ai_pro and trial: no change -- price_kobo stays NULL, purchasable stays
-- the column default (false), exactly per "Pro is not finalized... Keep
-- Pro unpublished or unavailable for purchase until the exact price is
-- approved."

-- ── 2) Pending-payment ledger (create_pending_purchase's own pattern) ───
CREATE TABLE IF NOT EXISTS public.ai_subscription_payments (
  reference            text PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id              text NOT NULL REFERENCES public.ai_plans(plan_id),
  expected_amount_kobo integer NOT NULL CHECK (expected_amount_kobo > 0),
  currency             text NOT NULL DEFAULT 'NGN',
  billing_period_days  integer NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  confirmed_at         timestamptz
);

ALTER TABLE public.ai_subscription_payments ENABLE ROW LEVEL SECURITY;
-- No policies -- same reasoning as ai_entitlements/ai_usage_periods: all
-- access goes through SECURITY DEFINER RPCs below, never a direct table
-- read/write by anon/authenticated.

CREATE INDEX IF NOT EXISTS idx_ai_subscription_payments_user_id ON public.ai_subscription_payments(user_id);

-- ── 3) Public, read-only plan list (purchasable plans only) ─────────────
-- Separate from ai_plans itself (which has zero direct grants at all, per
-- 0165) -- this is the one safe, intentionally-narrow read a client needs
-- to render a real paywall: never exposes the trial plan's parameters or
-- an unpublished/unpriced plan (ai_pro) to the client at all.
CREATE OR REPLACE FUNCTION public.get_ai_plans_public()
 RETURNS TABLE (plan_id text, label text, included_units integer, hard_ceiling integer, price_kobo integer, currency text, billing_period_days integer)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT plan_id, label, included_units, hard_ceiling, price_kobo, currency, billing_period_days
  FROM public.ai_plans
  WHERE active AND purchasable AND price_kobo IS NOT NULL
  ORDER BY price_kobo ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_ai_plans_public() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ai_plans_public() TO authenticated, project_admin;

-- ── 4) Create a pending payment (client-callable: records INTENT only) ──
-- Mirrors create_pending_purchase's own authority model exactly: this
-- grants nothing by itself, only records "this authenticated user intends
-- to pay X kobo, server-computed from ai_plans, for plan Y" under a fresh
-- disposable reference. Uses auth.uid() internally (never a p_user_id
-- parameter), so there is no argument through which a caller could create
-- a pending payment attributed to someone else.
CREATE OR REPLACE FUNCTION public.initiate_ai_subscription_payment(p_plan_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_plan public.ai_plans;
  v_ref  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_plan FROM public.ai_plans WHERE plan_id = p_plan_id;
  IF v_plan IS NULL OR NOT v_plan.active OR NOT v_plan.purchasable OR v_plan.price_kobo IS NULL THEN
    -- Same refusal for "unknown plan" and "exists but not purchasable"
    -- (e.g. ai_pro) -- never lets a client buy a plan with no approved
    -- price, whatever plan_id it asks for.
    RAISE EXCEPTION 'plan_not_purchasable' USING ERRCODE = 'P0001';
  END IF;

  v_ref := 'aisub_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.ai_subscription_payments (reference, user_id, plan_id, expected_amount_kobo, currency, billing_period_days)
  VALUES (v_ref, v_uid, p_plan_id, v_plan.price_kobo, v_plan.currency, v_plan.billing_period_days);

  RETURN jsonb_build_object('reference', v_ref, 'amount_kobo', v_plan.price_kobo, 'currency', v_plan.currency, 'plan_id', p_plan_id, 'label', v_plan.label);
END;
$function$;

REVOKE ALL ON FUNCTION public.initiate_ai_subscription_payment(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.initiate_ai_subscription_payment(text) TO authenticated, project_admin;

-- ── 5) Ownership lookup for api/webhook/paystack.ts's verify path ───────
-- Same shape/purpose as get_wallet_deposit_owner (0065) -- lets the verify
-- endpoint confirm the caller owns this reference before spending a
-- Paystack API call on their say-so.
CREATE OR REPLACE FUNCTION public.get_ai_subscription_payment_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT user_id FROM public.ai_subscription_payments WHERE reference = p_reference;
$function$;

REVOKE ALL ON FUNCTION public.get_ai_subscription_payment_owner(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_subscription_payment_owner(text) TO project_admin;

-- ── 6) Server-side confirmation (project_admin only, never client-callable)
-- Mirrors confirm_wallet_deposit's own idempotency/amount-matching shape
-- exactly. Called ONLY from api/webhook/paystack.ts via the trusted
-- project_admin connection, with p_amount_kobo always Paystack's OWN
-- verified amount from their /transaction/verify or a signed
-- charge.success webhook event -- never a client-supplied number.
CREATE OR REPLACE FUNCTION public.confirm_ai_subscription_payment(p_reference text, p_amount_kobo integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_pay public.ai_subscription_payments;
BEGIN
  SELECT * INTO v_pay FROM public.ai_subscription_payments WHERE reference = p_reference FOR UPDATE;

  IF v_pay IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Idempotent: a retried webhook delivery or a client verify call that
  -- races the webhook both land here safely -- whichever runs first wins,
  -- the other is a no-op that still reports success (the payment IS
  -- confirmed, just not by this call).
  IF v_pay.status = 'confirmed' THEN
    RETURN jsonb_build_object('status', 'already_confirmed', 'plan_id', v_pay.plan_id);
  END IF;

  IF p_amount_kobo <> v_pay.expected_amount_kobo THEN
    RETURN jsonb_build_object('status', 'amount_mismatch', 'expected_kobo', v_pay.expected_amount_kobo, 'got_kobo', p_amount_kobo);
  END IF;

  UPDATE public.ai_subscription_payments SET status = 'confirmed', confirmed_at = now() WHERE reference = p_reference;

  -- Grant/extend the entitlement -- same upsert shape as start_ai_trial()
  -- and admin_set_ai_entitlement() above, 'active' status, a real
  -- period_end from the plan's own billing_period_days, provider/
  -- external_transaction_id recorded for future reconciliation.
  INSERT INTO public.ai_entitlements (user_id, plan_id, status, period_start, period_end, provider, external_product_id, external_transaction_id)
  VALUES (v_pay.user_id, v_pay.plan_id, 'active', now(), now() + make_interval(days => v_pay.billing_period_days), 'paystack', v_pay.plan_id, p_reference)
  ON CONFLICT (user_id) DO UPDATE SET
    plan_id = v_pay.plan_id, status = 'active', period_start = now(),
    period_end = now() + make_interval(days => v_pay.billing_period_days),
    grace_until = NULL, provider = 'paystack', external_product_id = v_pay.plan_id,
    external_transaction_id = p_reference, updated_at = now();

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'ai_subscription_confirmed', v_pay.user_id,
    jsonb_build_object('plan_id', v_pay.plan_id, 'reference', p_reference, 'amount_kobo', p_amount_kobo), 'system');

  RETURN jsonb_build_object('status', 'confirmed', 'plan_id', v_pay.plan_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_ai_subscription_payment(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_ai_subscription_payment(text, integer) TO project_admin;
