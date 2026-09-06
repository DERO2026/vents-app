-- Real GPS-distance-sorted "Providers Near You" (Services). Additive only --
-- does not touch service_providers' existing columns/RLS/grants beyond
-- adding two nullable columns, and does not create any new table for a
-- customer's own location: their coordinates are only ever passed as
-- transient RPC parameters for a read query, never stored anywhere.

ALTER TABLE public.service_providers
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

-- Distance-ordered discovery. Deliberately NOT SECURITY DEFINER -- this
-- must respect service_providers' own RLS (service_providers_public_select_
-- approved, 0034) exactly like any other public discovery read, executing
-- as whichever role actually calls it (anon/authenticated), same as
-- fetchApprovedServiceProviders' plain .select(). Plain great-circle
-- (haversine) distance in kilometers -- no PostGIS extension assumed
-- available on this project, and this is precise enough for a "how far is
-- this provider" sort/display at city scale.
CREATE OR REPLACE FUNCTION public.get_nearby_service_providers(
  p_lat double precision,
  p_lng double precision,
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 20
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
  ORDER BY distance_km ASC
  LIMIT p_limit;
$function$
;

REVOKE ALL ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_nearby_service_providers(double precision, double precision, text, integer) TO anon, authenticated, project_admin;
