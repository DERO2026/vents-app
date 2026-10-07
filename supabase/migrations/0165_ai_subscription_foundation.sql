-- VENTS Phase 4 -- AI subscription backend foundation. Server-authoritative
-- entitlement + usage accounting for the VENTS AI chat assistant, so a
-- future App Store/Play Store subscription cannot be bypassed by calling
-- the API directly. This migration deliberately builds ONLY the backend
-- primitives (tables, RPCs, config placeholders) -- no App Store/Play
-- product IDs, no purchase flow, no client UI, and public pricing is not
-- finalized (ai_plans rows below are planning placeholders, editable later
-- without touching this schema).
--
-- Rollout safety: enforcement is OFF by default (app_config.
-- ai_entitlement_enforced = false). Every existing user currently has zero
-- rows in ai_entitlements, and this app has no purchase flow yet -- turning
-- enforcement on unconditionally in this migration would lock every
-- existing user out of VENTS AI chat the moment this ships, which is not
-- what "build the foundation" asked for. The flag lets a Root admin flip
-- enforcement on later, once real plans/purchases exist, without another
-- migration. All existing cost controls (kill switch, 20/hour/user,
-- 500/hour global, message/history caps, prompt caching, web-search cap)
-- are completely unaffected and keep working exactly as before regardless
-- of this flag.

-- ── 1) Plan configuration (placeholders, not final pricing) ─────────────
CREATE TABLE IF NOT EXISTS public.ai_plans (
  plan_id        text PRIMARY KEY,
  label          text NOT NULL,
  included_units integer NOT NULL CHECK (included_units >= 0),
  hard_ceiling   integer NOT NULL CHECK (hard_ceiling >= included_units),
  is_trial       boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_plans ENABLE ROW LEVEL SECURITY;
-- No policies -- no direct anon/authenticated access by design (same
-- pattern as public.rate_limits, 0026). Read via get_my_ai_entitlement()
-- below; write via the Root-gated admin RPCs further down.

INSERT INTO public.ai_plans (plan_id, label, included_units, hard_ceiling, is_trial, active) VALUES
  ('trial',   'VENTS AI Trial', 15,  15,  true,  true),
  ('ai',      'VENTS AI',       50,  75,  false, true),
  ('ai_plus', 'VENTS AI+',      100, 150, false, true),
  ('ai_pro',  'VENTS AI Pro',   220, 320, false, true)
ON CONFLICT (plan_id) DO NOTHING;

-- ── 2) Per-user entitlement (server-authoritative) ──────────────────────
CREATE TABLE IF NOT EXISTS public.ai_entitlements (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id      text NOT NULL REFERENCES public.ai_plans(plan_id),
  status       text NOT NULL DEFAULT 'inactive'
                 CHECK (status IN ('inactive', 'trialing', 'active', 'grace', 'expired', 'canceled')),
  period_start timestamptz,
  period_end   timestamptz,
  grace_until  timestamptz,
  -- 'provider' identifies who granted this entitlement (apple/google/manual/
  -- trial) for future store-receipt reconciliation -- no payment/receipt
  -- data lives here, only identifiers to look one up elsewhere later.
  provider               text,
  external_product_id    text,
  external_transaction_id text,
  -- Account-bound, one-time trial flag. Set exactly once by start_ai_trial()
  -- below and never resettable by any user-reachable path (no RPC below
  -- that is callable by authenticated/anon ever clears it) -- surviving
  -- reinstall/device change/client-state manipulation because it lives
  -- here, keyed by the Supabase auth user id, never on the device.
  trial_used   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_entitlements ENABLE ROW LEVEL SECURITY;
-- No policies -- all access via SECURITY DEFINER RPCs below. An ordinary
-- user has NO grant to SELECT/INSERT/UPDATE this table directly, so they
-- cannot claim a different plan, edit their own status/period, or clear
-- trial_used by any direct-table-write path (PostgREST or otherwise).

-- ── 3) Usage accounting, bucketed per surface + billing period ──────────
-- Keyed by the user's own entitlement period (period_start), not calendar
-- month -- a new period_start (set by a future renewal/rollover) is
-- automatically a fresh row with used_units starting at 0; nothing needs
-- to "reset" usage by hand. 'surface' keeps chat/extraction/vision
-- strictly separate ledgers (see check_and_reserve_ai_usage's own comment
-- for which surfaces are actually wired to enforcement today).
CREATE TABLE IF NOT EXISTS public.ai_usage_periods (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  surface      text NOT NULL CHECK (surface IN ('chat', 'extraction', 'vision')),
  period_start timestamptz NOT NULL,
  period_end   timestamptz,
  used_units   integer NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface, period_start)
);

ALTER TABLE public.ai_usage_periods ENABLE ROW LEVEL SECURITY;
-- No policies -- same reasoning as above. A client cannot reset or alter
-- its own usage by any direct write; the only writer is
-- check_and_reserve_ai_usage() below, which only ever increments.

-- ── 4) app_config flag: is subscription enforcement actually live? ──────
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS ai_entitlement_enforced boolean NOT NULL DEFAULT false;

-- Deliberately the OPPOSITE fail behavior of ai_disabled() (0163): that is
-- a kill switch (failing closed is the whole point -- an unreachable
-- config must never silently leave paid Anthropic spend open). This flag
-- is a monetization gate, not a cost-safety gate -- every real cost control
-- (kill switch, rate limits, caps) stays fully enforced regardless of this
-- flag's value or reachability. Failing "closed" here would mean an
-- app_config read hiccup blocks AI chat for every paying AND every
-- non-paying user at once, which is strictly worse than temporarily not
-- enforcing the paywall. COALESCE to false on any missing/unreadable row.
CREATE OR REPLACE FUNCTION public.ai_entitlement_enforced()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT ai_entitlement_enforced FROM public.app_config LIMIT 1), false);
$function$;

REVOKE ALL ON FUNCTION public.ai_entitlement_enforced() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_entitlement_enforced() TO authenticated, project_admin;

-- Thread the new flag through the existing Root-gated config writer.
CREATE OR REPLACE FUNCTION public.admin_update_app_config(p_field text, p_value text, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old     jsonb;
  v_new     jsonb;
  v_oldval  text;
  v_newval  text;
  v_bool    boolean;
  v_int     integer;
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to change platform configuration (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;

  IF p_field IS NULL THEN RAISE EXCEPTION 'p_field is required'; END IF;

  SELECT to_jsonb(c) INTO v_old FROM public.app_config c WHERE c.id = true;
  IF v_old IS NULL THEN RAISE EXCEPTION 'app_config singleton row is missing'; END IF;
  v_oldval := v_old ->> p_field;

  CASE p_field

    WHEN 'maintenance_mode' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET maintenance_mode = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_purchases' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_purchases = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_scanning' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_scanning = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_signups' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_signups = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_payouts' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_payouts = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_location_sharing' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_location_sharing = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_bookings' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_bookings = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_deposits' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_deposits = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_ai' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_ai = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    -- NEW switch (Phase 4)
    WHEN 'ai_entitlement_enforced' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET ai_entitlement_enforced = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    WHEN 'voice_notes_enabled' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET voice_notes_enabled = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'image_sharing_enabled' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET image_sharing_enabled = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    WHEN 'broadcast_message' THEN
      UPDATE public.app_config SET broadcast_message = NULLIF(p_value, ''), updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'min_client_version' THEN
      IF p_value IS NULL OR p_value !~ '^[0-9]+\.[0-9]+\.[0-9]+$' THEN
        RAISE EXCEPTION 'min_client_version must look like 1.2.3';
      END IF;
      UPDATE public.app_config SET min_client_version = p_value, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    WHEN 'vc_naira_per_1000' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int <= 0 OR v_int > 1000000 THEN
        RAISE EXCEPTION 'vc_naira_per_1000 must be between 1 and 1000000';
      END IF;
      UPDATE public.app_config SET vc_naira_per_1000 = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'vc_min_ticket_price' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int < 0 THEN
        RAISE EXCEPTION 'vc_min_ticket_price must be >= 0';
      END IF;
      UPDATE public.app_config SET vc_min_ticket_price = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'vc_max_redemption_pct' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int < 0 OR v_int > 100 THEN
        RAISE EXCEPTION 'vc_max_redemption_pct must be between 0 and 100';
      END IF;
      UPDATE public.app_config SET vc_max_redemption_pct = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    ELSE
      RAISE EXCEPTION 'Unknown or non-updatable app_config field: %', p_field;
  END CASE;

  SELECT to_jsonb(c) INTO v_new FROM public.app_config c WHERE c.id = true;
  v_newval := v_new ->> p_field;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'app_config_update',
    NULL,
    jsonb_build_object('field', p_field, 'old_value', v_oldval, 'new_value', v_newval, 'reason', p_reason),
    public.actor_role()
  );

  RETURN jsonb_build_object('field', p_field, 'old_value', v_oldval, 'new_value', v_newval);
END;
$function$;

-- ── 5) Atomic entitlement + usage enforcement ────────────────────────────
-- Called ONLY from trusted server code (api/_lib/aiAssistantHandler.ts) via
-- the project_admin Postgres connection (api/_lib/projectAdminDb.ts) --
-- never reachable via PostgREST by anon/authenticated, so p_user_id being
-- an explicit parameter is safe (same convention as
-- check_verify_account_rate_limit(p_email), 0163): only our own backend,
-- which has already verified the session via verifyInsforgeSession, can
-- call this at all, and it always passes that already-verified user's own
-- id -- a client has no path to call this function with someone else's id.
--
-- Does five things atomically in ONE statement-ordered function body,
-- fulfilling the request's "atomic enforcement" sequence (steps 3-6; the
-- kill switch (1) and auth (2) happen in the caller before this is ever
-- invoked):
--   1. Lock and read the entitlement row (FOR UPDATE -- serializes
--      concurrent requests from the same user so two simultaneous requests
--      can never both read "1 unit left" and both succeed).
--   2. Reject if there is no entitlement row, or it is not in an allowed
--      status (trialing/active/grace).
--   3. Reject (and flip to 'expired') if the entitlement's own period has
--      lapsed with no grace remaining.
--   4. Atomically increment this period's usage counter for this surface
--      (single INSERT ... ON CONFLICT ... RETURNING, same idiom as
--      check_rate_limit -- the row lock from the UPDATE path makes this
--      safe under real concurrency, not merely "usually fine").
--   5. If that increment pushed usage past the plan's hard ceiling,
--      compensate (decrement back) so the ledger reflects only genuinely
--      allowed calls, then reject.
-- Only on every one of those passing does this return normally, which is
-- the caller's one and only signal that it may actually call Anthropic.
CREATE OR REPLACE FUNCTION public.check_and_reserve_ai_usage(p_user_id uuid, p_surface text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ent          public.ai_entitlements;
  v_plan         public.ai_plans;
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_used         integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_surface NOT IN ('chat', 'extraction', 'vision') THEN
    RAISE EXCEPTION 'invalid p_surface: %', p_surface;
  END IF;

  -- Row lock: a second concurrent call for the same user blocks here until
  -- the first call's transaction commits or rolls back, so the two never
  -- interleave their reads of the same entitlement/usage state.
  SELECT * INTO v_ent FROM public.ai_entitlements WHERE user_id = p_user_id FOR UPDATE;

  IF v_ent IS NULL THEN
    RAISE EXCEPTION 'no_entitlement' USING ERRCODE = 'P0001';
  END IF;

  IF v_ent.status NOT IN ('trialing', 'active', 'grace') THEN
    RAISE EXCEPTION 'entitlement_inactive' USING ERRCODE = 'P0001';
  END IF;

  -- Period check. A NULL period_end (used by the open-ended trial, which is
  -- bounded by total units rather than a calendar period) never expires on
  -- time alone.
  IF v_ent.period_end IS NOT NULL AND v_ent.period_end < now() THEN
    IF v_ent.grace_until IS NOT NULL AND v_ent.grace_until >= now() THEN
      -- Within grace: allowed to proceed, but record the grace status so
      -- it's visible to anything inspecting the row later.
      IF v_ent.status <> 'grace' THEN
        UPDATE public.ai_entitlements SET status = 'grace', updated_at = now()
          WHERE user_id = p_user_id;
        v_ent.status := 'grace';
      END IF;
    ELSE
      UPDATE public.ai_entitlements SET status = 'expired', updated_at = now()
        WHERE user_id = p_user_id;
      RAISE EXCEPTION 'entitlement_expired' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO v_plan FROM public.ai_plans WHERE plan_id = v_ent.plan_id;
  IF v_plan IS NULL OR NOT v_plan.active THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Usage bucket key: the entitlement's OWN period, not the calendar month.
  -- The open-ended trial (period_end IS NULL) uses one single lifetime
  -- bucket per user (period_start fixed at the entitlement's own
  -- period_start, 'infinity' as the nominal end) so its total stays capped
  -- at the plan's hard_ceiling across the whole trial, not per-month.
  v_period_start := v_ent.period_start;
  v_period_end := COALESCE(v_ent.period_end, 'infinity'::timestamptz);

  INSERT INTO public.ai_usage_periods (user_id, surface, period_start, period_end, used_units, updated_at)
  VALUES (p_user_id, p_surface, v_period_start, v_period_end, 1, now())
  ON CONFLICT (user_id, surface, period_start)
  DO UPDATE SET used_units = public.ai_usage_periods.used_units + 1, updated_at = now()
  RETURNING used_units INTO v_used;

  IF v_used > v_plan.hard_ceiling THEN
    -- Compensate: this attempt is being rejected, so it must not count as
    -- used. The UPDATE below is itself a single atomic statement, so this
    -- stays race-safe even though it's a second statement in the same
    -- transaction as the increment above.
    UPDATE public.ai_usage_periods SET used_units = used_units - 1, updated_at = now()
      WHERE user_id = p_user_id AND surface = p_surface AND period_start = v_period_start;
    RAISE EXCEPTION 'usage_ceiling_exceeded' USING ERRCODE = 'P0429';
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'plan_id', v_ent.plan_id,
    'status', v_ent.status,
    'used_units', v_used,
    'included_units', v_plan.included_units,
    'hard_ceiling', v_plan.hard_ceiling,
    'over_included', v_used > v_plan.included_units
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_and_reserve_ai_usage(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_reserve_ai_usage(uuid, text) TO project_admin;

-- ── 6) One-time, account-bound trial grant ───────────────────────────────
-- Same reachability as check_and_reserve_ai_usage above: project_admin
-- only, called from trusted server code with the caller's own already-
-- verified user id. trial_used is checked and set inside the SAME locked
-- row read/write a concurrent call would also need, so two simultaneous
-- "start my trial" calls for the same user cannot both succeed.
CREATE OR REPLACE FUNCTION public.start_ai_trial(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ent  public.ai_entitlements;
  v_plan public.ai_plans;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  SELECT * INTO v_plan FROM public.ai_plans WHERE plan_id = 'trial';
  IF v_plan IS NULL OR NOT v_plan.active THEN
    RAISE EXCEPTION 'trial_plan_not_configured' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_ent FROM public.ai_entitlements WHERE user_id = p_user_id FOR UPDATE;

  IF v_ent IS NOT NULL AND v_ent.trial_used THEN
    RAISE EXCEPTION 'trial_already_used' USING ERRCODE = 'P0001';
  END IF;

  IF v_ent IS NULL THEN
    INSERT INTO public.ai_entitlements (user_id, plan_id, status, period_start, period_end, provider, trial_used)
    VALUES (p_user_id, 'trial', 'trialing', now(), NULL, 'trial', true);
  ELSE
    UPDATE public.ai_entitlements
      SET plan_id = 'trial', status = 'trialing', period_start = now(), period_end = NULL,
          grace_until = NULL, provider = 'trial', trial_used = true, updated_at = now()
      WHERE user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('plan_id', 'trial', 'status', 'trialing', 'included_units', v_plan.included_units, 'hard_ceiling', v_plan.hard_ceiling);
END;
$function$;

REVOKE ALL ON FUNCTION public.start_ai_trial(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_ai_trial(uuid) TO project_admin;

-- ── 7) Read-only self-service status (safe for a future UI; no writes) ──
-- The ONE function ordinary users get direct EXECUTE on. Uses auth.uid()
-- internally rather than a parameter, so a caller can only ever read their
-- own row -- there is no argument through which a user could ask for
-- someone else's entitlement/usage.
CREATE OR REPLACE FUNCTION public.get_my_ai_entitlement()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_ent  public.ai_entitlements;
  v_plan public.ai_plans;
  v_used integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_ent FROM public.ai_entitlements WHERE user_id = v_uid;
  IF v_ent IS NULL THEN
    RETURN jsonb_build_object('plan_id', NULL, 'status', 'inactive', 'trial_used', false);
  END IF;

  SELECT * INTO v_plan FROM public.ai_plans WHERE plan_id = v_ent.plan_id;

  SELECT used_units INTO v_used FROM public.ai_usage_periods
    WHERE user_id = v_uid AND surface = 'chat' AND period_start = v_ent.period_start;

  RETURN jsonb_build_object(
    'plan_id', v_ent.plan_id,
    'status', v_ent.status,
    'period_start', v_ent.period_start,
    'period_end', v_ent.period_end,
    'grace_until', v_ent.grace_until,
    'trial_used', v_ent.trial_used,
    'used_units', COALESCE(v_used, 0),
    'included_units', v_plan.included_units,
    'hard_ceiling', v_plan.hard_ceiling
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_ai_entitlement() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_ai_entitlement() TO authenticated, project_admin;

-- ── 8) Root-gated admin controls (ops/testing only, never user-reachable)─
-- Mirrors admin_update_app_config's own is_root() gate exactly. This is the
-- only way plan_id/status/period/grace can ever be set on someone's
-- entitlement outside start_ai_trial() -- no authenticated-callable path
-- can claim a different plan, extend a period, or clear trial_used.
CREATE OR REPLACE FUNCTION public.admin_set_ai_entitlement(
  p_user_id uuid,
  p_plan_id text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_grace_until timestamptz DEFAULT NULL,
  p_provider text DEFAULT 'manual',
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old jsonb;
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to set an AI entitlement (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ai_plans WHERE plan_id = p_plan_id) THEN
    RAISE EXCEPTION 'Unknown plan_id: %', p_plan_id;
  END IF;
  IF p_status NOT IN ('inactive', 'trialing', 'active', 'grace', 'expired', 'canceled') THEN
    RAISE EXCEPTION 'Unknown status: %', p_status;
  END IF;

  SELECT to_jsonb(e) INTO v_old FROM public.ai_entitlements e WHERE e.user_id = p_user_id;

  INSERT INTO public.ai_entitlements (user_id, plan_id, status, period_start, period_end, grace_until, provider, updated_at)
  VALUES (p_user_id, p_plan_id, p_status, p_period_start, p_period_end, p_grace_until, p_provider, now())
  ON CONFLICT (user_id) DO UPDATE SET
    plan_id = p_plan_id, status = p_status, period_start = p_period_start,
    period_end = p_period_end, grace_until = p_grace_until, provider = p_provider, updated_at = now();

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'ai_entitlement_set', p_user_id,
    jsonb_build_object('old', v_old, 'plan_id', p_plan_id, 'status', p_status, 'reason', p_reason),
    public.actor_role());

  RETURN jsonb_build_object('user_id', p_user_id, 'plan_id', p_plan_id, 'status', p_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_ai_entitlement(uuid, text, text, timestamptz, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_ai_entitlement(uuid, text, text, timestamptz, timestamptz, timestamptz, text, text) TO project_admin;

CREATE OR REPLACE FUNCTION public.admin_set_ai_plan(
  p_plan_id text,
  p_included_units integer,
  p_hard_ceiling integer,
  p_active boolean DEFAULT true,
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old jsonb;
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to change AI plan configuration (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;
  IF p_hard_ceiling < p_included_units THEN
    RAISE EXCEPTION 'hard_ceiling (%) cannot be less than included_units (%)', p_hard_ceiling, p_included_units;
  END IF;

  SELECT to_jsonb(p) INTO v_old FROM public.ai_plans p WHERE p.plan_id = p_plan_id;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'Unknown plan_id: % (plans are created by migration, not this RPC)', p_plan_id;
  END IF;

  UPDATE public.ai_plans
    SET included_units = p_included_units, hard_ceiling = p_hard_ceiling, active = p_active, updated_at = now()
    WHERE plan_id = p_plan_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'ai_plan_update', NULL,
    jsonb_build_object('plan_id', p_plan_id, 'old', v_old, 'included_units', p_included_units, 'hard_ceiling', p_hard_ceiling, 'active', p_active, 'reason', p_reason),
    public.actor_role());

  RETURN jsonb_build_object('plan_id', p_plan_id, 'included_units', p_included_units, 'hard_ceiling', p_hard_ceiling, 'active', p_active);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_ai_plan(text, integer, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_ai_plan(text, integer, integer, boolean, text) TO project_admin;
