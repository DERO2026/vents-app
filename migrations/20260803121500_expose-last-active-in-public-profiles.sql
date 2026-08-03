-- Online status needs last_active_at on the *other* user, which
-- public_profiles doesn't expose yet (users.last_active_at was just added
-- in the previous migration). Same pattern as
-- 20260621140935_public-profiles-add-interests-bio-badge.sql.
DROP VIEW IF EXISTS public_profiles;
DROP FUNCTION IF EXISTS get_public_profiles();

CREATE OR REPLACE FUNCTION get_public_profiles()
RETURNS TABLE(
  id uuid,
  full_name text,
  username text,
  avatar_url text,
  cover_url text,
  is_verified boolean,
  state text,
  role text,
  interests text[],
  bio text,
  vc_badge text,
  last_active_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    id,
    full_name,
    username,
    avatar_url,
    cover_url,
    is_verified,
    state,
    CASE WHEN role = 'admin' THEN 'organizer' ELSE role END AS role,
    interests,
    bio,
    vc_badge,
    last_active_at
  FROM public.users
  WHERE deleted_at IS NULL;
$$;

CREATE VIEW public_profiles AS
  SELECT
    id, full_name, username, avatar_url, cover_url, is_verified, state, role,
    interests, bio, vc_badge, last_active_at
  FROM get_public_profiles();

GRANT SELECT ON public_profiles TO authenticated, anon;
