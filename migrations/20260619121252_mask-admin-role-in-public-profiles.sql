-- Mask admin role in public_profiles: admin accounts appear as 'organizer' to the public
-- Prevents any authenticated user from identifying the admin account via role enumeration

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
  SELECT
    id,
    full_name,
    username,
    avatar_url,
    cover_url,
    is_verified,
    state,
    CASE WHEN role = 'admin' THEN 'organizer' ELSE role END AS role
  FROM public.users;
$$;

CREATE VIEW public.public_profiles AS
  SELECT id, full_name, username, avatar_url, cover_url, is_verified, state, role
  FROM get_public_profiles();

GRANT SELECT ON public.public_profiles TO anon, authenticated;
