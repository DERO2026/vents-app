-- Fix: "Providers Near You" had no maximum radius -- it sorted every
-- geocoded, in-country provider by distance and returned the top N
-- regardless of how far away the nearest one actually was. With few or no
-- providers geocoded near the user, this could return someone hundreds of
-- kilometers away under a "Near You" heading, with no distance ever shown
-- in the UI (ServiceProviderCard never renders distance_km) -- indistinguishable
-- from a genuinely nearby result. "Nearby" needs an actual cutoff, not just
-- "nearest of whichever ones exist".
--
-- p_max_distance_km defaults to 100 -- generous enough to still cover a
-- metro area/state capital's surrounding region (the geography this app's
-- users are actually in) without labeling a same-country but different-
-- region provider hundreds of km away as "near you".
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
 LANGUAGE sql
 STABLE
AS $function$
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
$function$
;

DROP FUNCTION IF EXISTS public.get_nearby_service_providers(double precision, double precision, text, integer, text);

REVOKE ALL ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer, text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer, text, double precision) TO anon, authenticated, project_admin;
