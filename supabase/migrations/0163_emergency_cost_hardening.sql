-- Emergency cost/billing hardening, following the full production billing
-- audit. Server-side only, by design: every client-installed VENTS build
-- (App Store/Play Store, any version) talks to this same live database, so
-- a change here protects already-installed apps without a new release.
--
-- Scope (see the companion Vercel changes in api/_lib/verifyAuth.ts,
-- api/extract-events.ts, api/_lib/aiAssistantHandler.ts,
-- api/notify/status-email.ts, src/lib/mediaPipeline.ts for the server-code
-- half of this same hardening pass):
--   1. Anthropic emergency kill switch (app_config.disable_ai), same
--      fail-closed pattern as 0124_emergency_kill_switches.sql.
--   2. get_public_profiles(): hard result-count ceiling (see note below --
--      this is a real tradeoff, not a free fix).
--   3. get_nearby_service_providers / search_services_fuzzy: a shared
--      (global, not per-user -- both are anon-reachable with no login, so
--      there is no per-caller identity to key on) rate limit, closing the
--      "script it in a loop, anon, no cap at all" gap the audit found.
--   4. New check_verify_account_rate_limit()/check_media_upload_rate_limit()
--      helpers for the two app-code call sites that need a DB-backed limit
--      but have no existing one to reuse.

-- ── 1) Anthropic emergency kill switch ──────────────────────────────────
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS disable_ai boolean NOT NULL DEFAULT false;

-- Same fail-closed shape as purchases_disabled()/payouts_disabled()/etc
-- (0124): COALESCE a missing/unreadable config row to true (AI disabled),
-- never to false. A misconfigured or momentarily-unreachable app_config
-- row must never silently leave the Anthropic spigot open.
CREATE OR REPLACE FUNCTION public.ai_disabled()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT disable_ai FROM public.app_config LIMIT 1), true);
$function$;

REVOKE ALL ON FUNCTION public.ai_disabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_disabled() TO authenticated, project_admin;

-- Thread disable_ai through the existing Root-gated whitelist writer so
-- AdminSystemScreen.tsx can add a toggle for it the same way every other
-- kill switch already works -- no new admin-UI mechanism, just one more
-- case in an existing, already-audited CASE statement.
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
    -- NEW switch
    WHEN 'disable_ai' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_ai = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

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

-- ── 2) get_public_profiles(): hard result-count ceiling ─────────────────
-- Honest note on this one, since it's a real tradeoff and not a free fix:
-- every actual client call site (grepped across src/) queries the
-- public_profiles VIEW with a `.eq('id', ...)`/`.in('id', [...])` filter,
-- never an unfiltered select-all. Confirmed live via
-- `EXPLAIN (COSTS OFF) SELECT * FROM public.public_profiles WHERE id = ...`
-- that Postgres does NOT push that filter into this function (plan shows
-- "Function Scan on get_public_profiles" -> "Filter: (id = ...)", i.e. the
-- full function result is computed FIRST and filtered AFTER) -- this holds
-- even though the function is already a plain LANGUAGE SQL STABLE
-- SECURITY DEFINER function (migration 0153), not plpgsql. There is no
-- way to make PostgREST forward a client's filter INTO this function's own
-- arguments (the view always calls it the same zero-arg way), so the real
-- fix for "every call, filtered or not, scans every user" would require a
-- client-code change (a view generally can't be made SECURITY INVOKER here
-- since anon/authenticated have no SELECT grant on the underlying users
-- table at all -- that's the whole reason this function/view pair exists).
-- A client-code change does NOT reach already-installed native app
-- builds without a new release, so it is out of scope for this
-- emergency, server-only pass -- noted as a deferred follow-up.
--
-- What IS fixed here, with zero client-code change required: a hard
-- ceiling on how many rows this function can EVER return in one call,
-- closing the literal "anyone can dump the entire users table in one
-- request" exposure the audit flagged. ORDER BY id keeps the ceiling
-- deterministic rather than scanning in whatever order the table happens
-- to be stored in. 5000 is chosen generously high specifically so it does
-- not affect any realistic `.in(ids)` batch lookup today or for a long
-- time to come -- it is a backstop against a true full-table-dump at
-- large scale, not a pagination mechanism (see the note above on why real
-- pagination needs a client change this pass cannot make).
CREATE OR REPLACE FUNCTION public.get_public_profiles()
 RETURNS TABLE(id uuid, full_name text, username text, avatar_url text, cover_url text, is_verified boolean, state text, role text, is_organizer boolean, interests text[], bio text, vc_badge text, last_active_at timestamp with time zone, instagram_handle text, x_handle text, tiktok_handle text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    id,
    full_name,
    username,
    avatar_url,
    cover_url,
    is_verified,
    state,
    CASE WHEN role = 'admin' THEN 'organizer' ELSE role END AS role,
    is_organizer,
    interests,
    bio,
    vc_badge,
    last_active_at,
    instagram_handle,
    x_handle,
    tiktok_handle
  FROM public.users
  WHERE deleted_at IS NULL
  ORDER BY id
  LIMIT 5000;
$function$;

-- ── 3) get_nearby_service_providers / search_services_fuzzy: shared rate
--    limit ───────────────────────────────────────────────────────────────
-- Both are anon-reachable (no login required for "Near You"/service
-- search, by design -- preserved here) and were previously granted with
-- NO rate limit of any kind (unlike search_users_for_request, 0069, which
-- already rate-limits itself). Since anon has no stable per-caller
-- identity to key a limit on, this uses one shared, GLOBAL bucket per
-- function rather than a per-user one -- a real limit (closing "script it
-- in a loop with no cap at all"), accepting that one abusive anonymous
-- script can temporarily use up the shared allowance for genuine
-- anonymous users too. 1000 calls/60s is generous for real traffic at
-- today's scale and a long way below "genuinely free to hammer".
-- Converted from LANGUAGE sql to plpgsql solely to add this PERFORM --
-- every other line of logic, the signature, and the return shape are
-- unchanged.
CREATE OR REPLACE FUNCTION public.get_nearby_service_providers(
  p_lat double precision,
  p_lng double precision,
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_country text DEFAULT NULL,
  p_max_distance_km double precision DEFAULT 100
)
 RETURNS TABLE(
  id uuid, user_id uuid, business_name text, category text, description text,
  location text, country text, photo_urls text[], starting_price numeric,
  starting_price_currency text, services_offered text[], offers_home_service boolean,
  offers_delivery boolean, offers_same_day boolean, status text,
  created_at timestamptz, updated_at timestamptz, distance_km double precision
 )
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.check_rate_limit('nearby_providers_global', 1000, 60);

  RETURN QUERY
  SELECT * FROM (
    SELECT
      sp.id, sp.user_id, sp.business_name, sp.category, sp.description,
      sp.location, sp.country, sp.photo_urls, sp.starting_price,
      sp.starting_price_currency, sp.services_offered, sp.offers_home_service,
      sp.offers_delivery, sp.offers_same_day, sp.status, sp.created_at, sp.updated_at,
      (
        6371 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians(p_lat)) * cos(radians(sp.latitude)) * cos(radians(sp.longitude) - radians(p_lng))
            + sin(radians(p_lat)) * sin(radians(sp.latitude))
          ))
        )
      ) AS distance_km
    FROM public.service_providers sp
    WHERE sp.status = 'approved'
      AND sp.latitude IS NOT NULL
      AND sp.longitude IS NOT NULL
      AND (p_category IS NULL OR EXISTS (
        SELECT 1 FROM public.service_provider_categories spc
        WHERE spc.provider_id = sp.id AND spc.category = p_category
      ))
      AND (p_country IS NULL OR sp.country = p_country)
  ) scored
  WHERE p_max_distance_km IS NULL OR scored.distance_km <= p_max_distance_km
  ORDER BY scored.distance_km ASC
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_services_fuzzy(
  p_query text,
  p_category text DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE(
  provider_id uuid,
  business_name text,
  provider_category text,
  provider_description text,
  location text,
  starting_price numeric,
  starting_price_currency text,
  service_id uuid,
  service_name text,
  service_description text,
  service_price numeric,
  service_currency text,
  match_score real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.check_rate_limit('search_services_fuzzy_global', 1000, 60);

  RETURN QUERY
  SELECT
    sp.id AS provider_id,
    sp.business_name,
    sp.category AS provider_category,
    sp.description AS provider_description,
    sp.location,
    sp.starting_price,
    sp.starting_price_currency,
    ps.id AS service_id,
    ps.name AS service_name,
    ps.description AS service_description,
    ps.price AS service_price,
    ps.currency AS service_currency,
    GREATEST(
      public.similarity(coalesce(ps.name, ''), coalesce(p_query, '')),
      public.similarity(coalesce(ps.description, ''), coalesce(p_query, '')),
      public.similarity(coalesce(sp.business_name, ''), coalesce(p_query, '')),
      public.similarity(coalesce(sp.description, ''), coalesce(p_query, '')),
      public.similarity(coalesce(sp.category, ''), coalesce(p_query, ''))
    ) AS match_score
  FROM public.provider_services ps
  JOIN public.service_providers sp ON sp.id = ps.provider_id
  WHERE
    sp.status = 'approved'
    AND ps.is_active = true
    AND (
      p_category IS NULL
      OR sp.category = p_category
      OR ps.category = p_category
      OR EXISTS (
        SELECT 1 FROM public.service_provider_categories spc
        WHERE spc.provider_id = sp.id AND spc.category = p_category
      )
    )
    AND (
      coalesce(p_query, '') = ''
      OR ps.name ILIKE '%' || p_query || '%'
      OR ps.description ILIKE '%' || p_query || '%'
      OR sp.business_name ILIKE '%' || p_query || '%'
      OR sp.description ILIKE '%' || p_query || '%'
      OR sp.category ILIKE '%' || p_query || '%'
      OR public.similarity(coalesce(ps.name, ''), p_query) > 0.2
      OR public.similarity(coalesce(sp.business_name, ''), p_query) > 0.2
    )
  ORDER BY match_score DESC, sp.created_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
END;
$function$;

-- check_rate_limit() is EXECUTE-revoked from anon/authenticated directly
-- (0026) and only callable from inside another SECURITY DEFINER function --
-- both functions above already run as SECURITY DEFINER/STABLE-owner, so no
-- additional grant is needed for the PERFORM call itself. Grants on the two
-- outer functions are unchanged by this migration (still anon+authenticated
-- for get_nearby_service_providers per 0117/0115; still anon+authenticated
-- for search_services_fuzzy per 0081) -- preserving the exact same
-- reachability, only adding the missing limit.

-- ── 4) New limiter helpers for app-code call sites with no existing one ──

-- verify_account email send (api/notify/status-email.ts) is deliberately
-- unauthenticated (fires pre-signup, before any session exists) -- there is
-- no auth.uid() to key a limit on, and the Vercel route calls this over the
-- trusted project_admin connection (never via anon/authenticated PostgREST),
-- so EXECUTE is restricted to project_admin only. Fails CLOSED by
-- construction: check_rate_limit raises on both a real limit hit AND any
-- unexpected internal error (it does not swallow/soften anything), and this
-- wrapper does not catch that exception -- any error here reaches the
-- caller as a real exception, and the Vercel-side caller (see
-- api/notify/status-email.ts) treats anything other than a clean return as
-- "do not send," never as "allow by default."
CREATE OR REPLACE FUNCTION public.check_verify_account_rate_limit(p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION 'p_email is required';
  END IF;
  PERFORM public.check_rate_limit('verify_account_email:' || lower(trim(p_email)), 5, 3600);
END;
$function$;

REVOKE ALL ON FUNCTION public.check_verify_account_rate_limit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_verify_account_rate_limit(text) TO project_admin;

-- Media-upload count limit (src/lib/mediaPipeline.ts) -- a best-effort,
-- in-app-client gate: it stops the VENTS app's own JS from uploading past
-- the limit, the same way every other check_rate_limit-backed gate in this
-- codebase works, but (like those) it cannot stop a caller who bypasses the
-- app entirely and talks to Supabase Storage directly with a valid session
-- token -- that would need a Storage-level policy with its own counting
-- table, a larger change not made in this pass. Keyed per authenticated
-- user; authenticated-only (no anon uploads exist in this app).
CREATE OR REPLACE FUNCTION public.check_media_upload_rate_limit()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  PERFORM public.check_rate_limit('media_upload:' || v_uid::text, 30, 3600);
END;
$function$;

REVOKE ALL ON FUNCTION public.check_media_upload_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_media_upload_rate_limit() TO authenticated;
