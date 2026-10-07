-- Phase 2 cost/billing hardening -- second production audit, following
-- f390ef6/e9fe9b8/e0a1e73 (the emergency Anthropic kill switch + round-1
-- fixes). Pure, safe, zero-behavior-change performance indexes -- no
-- function signature, grant, or query-result change in this file.
--
-- ── A) search_services_fuzzy: trigram indexes ───────────────────────────
-- Confirmed live (EXPLAIN on the function's own query, run directly
-- against the tables) that provider_services.name/description and
-- service_providers.business_name/description/category have NO
-- supporting index at all -- every ILIKE/similarity() comparison in
-- search_services_fuzzy (0163_emergency_cost_hardening.sql) is a
-- sequential scan. pg_trgm is already enabled and this exact pattern
-- (GIN + gin_trgm_ops) is already used for events.title/location/category
-- and users.full_name/username -- this just extends the same, already-
-- proven convention to the two tables this RPC actually scans. Table
-- sizes are tiny today (2 service_providers rows), so this has no visible
-- effect yet -- it's here specifically so the sequential-scan cost this
-- RPC's existing 1000-calls/60s rate limit (0163) still allows doesn't
-- compound into real query cost once the provider catalog grows.
CREATE INDEX IF NOT EXISTS idx_provider_services_name_trgm ON public.provider_services USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_provider_services_description_trgm ON public.provider_services USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_service_providers_business_name_trgm ON public.service_providers USING gin (business_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_service_providers_description_trgm ON public.service_providers USING gin (description gin_trgm_ops);

-- ── B) get_nearby_service_providers: partial index on the WHERE clause ──
-- The function's distance expression (Haversine via acos/cos/sin) can
-- never be index-accelerated by a plain btree -- that would need a real
-- PostGIS geography column, explicitly out of scope for this pass (a
-- schema rewrite, not a safe low-risk improvement). What CAN be sped up
-- without any such rewrite: the WHERE clause that runs BEFORE the
-- distance calculation (status = 'approved' AND latitude/longitude NOT
-- NULL) currently has only a plain btree on status (idx_service_providers_
-- status, pre-existing) -- this partial index lets the planner skip
-- straight to exactly the approved+geocoded rows (and, via its own
-- country column, the p_country filter too) without touching rows that
-- can never match a "Near You" query (unapproved, or never geocoded) at
-- all. Zero change to the function itself, its signature, its 100km
-- radius cap, or its real geolocation behavior -- purely an index the
-- planner may or may not choose to use.
CREATE INDEX IF NOT EXISTS idx_service_providers_approved_geocoded
  ON public.service_providers (country)
  WHERE status = 'approved' AND latitude IS NOT NULL AND longitude IS NOT NULL;
