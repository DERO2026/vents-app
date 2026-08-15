-- public_profiles view had the same Supabase-default-privilege leakage as
-- the base tables (0012) — TRUNCATE/REFERENCES/TRIGGER granted to
-- anon/authenticated by platform default, not requested. TRUNCATE on a view
-- is a harmless no-op (Postgres refuses to truncate a view at runtime), but
-- fixing for exact fidelity with InsForge's real grant state.
REVOKE ALL ON public.public_profiles FROM PUBLIC, anon, authenticated;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.public_profiles TO anon;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.public_profiles TO authenticated;
