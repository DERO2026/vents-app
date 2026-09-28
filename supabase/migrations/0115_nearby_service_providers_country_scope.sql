-- Fix: "Providers Near You" (GPS-based discovery) ignored the user's
-- selected discovery country entirely, so a user physically in Nigeria who
-- explicitly picked e.g. Afghanistan in the Services country picker still
-- saw Nigerian-priced providers -- the GPS branch in ServicesHomeScreen/
-- HomeScreen never passed country through to get_nearby_service_providers.
--
-- Adds an optional p_country filter (matches service_providers.country,
-- the same ISO 3166-1 alpha-2 column fetchApprovedServiceProviders already
-- filters on). NULL preserves the old unscoped behavior for any caller
-- that genuinely wants global-nearest (none currently do, after the
-- frontend fix in the same change, but keeping it optional avoids forcing
-- a signature-breaking change on every caller).
CREATE OR REPLACE FUNCTION public.get_nearby_service_providers(
  p_lat double precision,
  p_lng double precision,
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_country text DEFAULT NULL
)
 RETURNS TABLE(
  id uuid, user_id uuid, business_name text, category text, description text,
  location text, country text, photo_urls text[], starting_price numeric,
  starting_price_currency text, services_offered text[], offers_home_service boolean,
  offers_delivery boolean, offers_same_day boolean, status text,
  created_at timestamptz, updated_at timestamptz, distance_km double precision
 )
 LANGUAGE sql
 STABLE
AS $function$
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
  ORDER BY distance_km ASC
  LIMIT p_limit;
$function$
;

-- Signature changed (added p_country) -- drop the old 4-arg overload so
-- PostgREST doesn't end up with two ambiguous get_nearby_service_providers
-- functions.
DROP FUNCTION IF EXISTS public.get_nearby_service_providers(double precision, double precision, text, integer);

REVOKE ALL ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer, text) TO anon, authenticated, project_admin;
