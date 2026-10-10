-- Release-blocker fix: VENTS AI's "recommend_providers" tool (and
-- ServicesHomeScreen/HomeScreen's own "Providers Near You" GPS path, same
-- RPC) failed on EVERY call with real coordinates, surfacing to users as
-- "Couldn't load providers near you." Root cause confirmed live against
-- production (slrtjxtzhowhwhebjprv), not assumed:
--
-- get_nearby_service_providers() is LANGUAGE plpgsql STABLE -- deliberately
-- NOT SECURITY DEFINER (0115_nearby_service_providers_country_scope.sql's
-- own static test locks this in: "preserves ... the not-SECURITY-DEFINER,
-- RLS-respecting execution model"). 0163_emergency_cost_hardening.sql later
-- added `PERFORM public.check_rate_limit('nearby_providers_global', 1000,
-- 60);` inside it, with a comment claiming "both functions above already
-- run as SECURITY DEFINER/STABLE-owner, so no additional grant is needed
-- for the PERFORM call itself." That's true for search_services_fuzzy
-- (confirmed live: it IS SECURITY DEFINER, unaffected by this bug) but
-- false for get_nearby_service_providers (confirmed live: prosecdef =
-- false). check_rate_limit() itself has EXECUTE granted only to postgres
-- and project_admin (0026_lock_down_unrestricted_tables.sql) -- so the
-- nested PERFORM runs as the REAL calling role (anon/authenticated, since
-- this function is SECURITY INVOKER) and hits a hard permission-denied
-- error on every single call, regardless of coordinates, category, or
-- distance. This has nothing to do with GPS/location handling, provider
-- approval, or distance filtering -- all of which were already correct.
--
-- Fix: do NOT grant EXECUTE on check_rate_limit() itself to anon/
-- authenticated (that would let any caller invoke it with an arbitrary key
-- and arbitrary limits, a much broader attack surface than this bug
-- warrants). Instead, follow the exact pattern already established by
-- check_verify_account_rate_limit()/check_media_upload_rate_limit() in
-- 0163: a narrow SECURITY DEFINER wrapper with zero caller-controlled
-- parameters, hardcoded to the one global key/limit this call site always
-- used, granted only to the two roles that were already supposed to reach
-- it (anon, authenticated -- matching get_nearby_service_providers' own
-- existing grants, unchanged). get_nearby_service_providers itself stays
-- SECURITY INVOKER/RLS-respecting, exactly as 0115 requires -- only the
-- nested rate-limit call is re-routed through a role that can actually run
-- it.
CREATE OR REPLACE FUNCTION public.check_nearby_providers_rate_limit()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.check_rate_limit('nearby_providers_global', 1000, 60);
END;
$function$;

REVOKE ALL ON FUNCTION public.check_nearby_providers_rate_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_nearby_providers_rate_limit() TO anon, authenticated, project_admin;

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
  PERFORM public.check_nearby_providers_rate_limit();

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

-- Grants on get_nearby_service_providers itself are unchanged by this
-- migration (still anon, authenticated, project_admin per 0115) --
-- re-asserted here only for clarity, not because they were wrong.
REVOKE ALL ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer, text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer, text, double precision) TO anon, authenticated, project_admin;
