-- VENTS AI Phase 1: fuzzy search over Services/Providers, for the
-- search_services_or_providers tool in api/_lib/aiTools.ts. No fuzzy/keyword
-- search RPC existed for services before this (search_events_fuzzy (0004)
-- is events-only) -- this fills that gap using the exact same visibility
-- rules the existing Services discovery screens already enforce via RLS
-- (service_providers.status = 'approved', 0034; provider_services.is_active
-- = true under an approved listing, 0048), so this SECURITY DEFINER
-- function cannot surface anything a plain anon/authenticated client
-- couldn't already see through those two tables' own public SELECT
-- policies -- it only removes the round trip of listing everything and
-- filtering client-side.
--
-- pg_trgm is already enabled (0001_extensions_schemas_roles.sql) and already
-- used for search_events_fuzzy-style matching elsewhere in this codebase, so
-- this uses similarity() (via the `%` operator's underlying function, called
-- directly here for an explicit per-row score) rather than a second ILIKE-
-- only implementation.

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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
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
    -- Same visibility floor as provider_services_public_select /
    -- service_providers_public_select_approved (0034/0048): only an
    -- ACTIVE service under an APPROVED listing is ever returned.
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
$function$
;

REVOKE ALL ON FUNCTION public.search_services_fuzzy(text, text, int) FROM PUBLIC, project_admin;
GRANT EXECUTE ON FUNCTION public.search_services_fuzzy(text, text, int) TO anon, authenticated, project_admin;
