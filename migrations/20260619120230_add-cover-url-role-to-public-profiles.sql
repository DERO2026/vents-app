-- Add cover_url and role to get_public_profiles function and public_profiles view
-- Required for ExploreScreen people search to return cover photos and creator badges

DROP VIEW IF EXISTS public.public_profiles;
DROP FUNCTION IF EXISTS public.get_public_profiles();

CREATE OR REPLACE FUNCTION public.get_public_profiles()
RETURNS TABLE(
  id uuid,
  full_name text,
  username text,
  avatar_url text,
  cover_url text,
  is_verified boolean,
  state text,
  role text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id, full_name, username, avatar_url, cover_url, is_verified, state, role
  FROM public.users;
$$;

CREATE VIEW public.public_profiles AS
  SELECT
    id, full_name, username, avatar_url, cover_url, is_verified, state, role
  FROM get_public_profiles();

GRANT SELECT ON public.public_profiles TO anon, authenticated;
