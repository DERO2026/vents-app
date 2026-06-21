-- Extend public_profiles to include interests, bio, and vc_badge
DROP VIEW IF EXISTS public_profiles;
DROP FUNCTION IF EXISTS get_public_profiles();

-- These fields were missing from get_public_profiles() causing:
--   - interests showing city name instead of real interests (bug: interests = [state])
--   - vc_badge not visible on user profiles

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
  vc_badge text
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
    vc_badge
  FROM public.users
  WHERE deleted_at IS NULL;
$$;

-- Recreate the view to pick up the new columns
DROP VIEW IF EXISTS public_profiles;
CREATE VIEW public_profiles AS
  SELECT
    id, full_name, username, avatar_url, cover_url, is_verified, state, role,
    interests, bio, vc_badge
  FROM get_public_profiles();

GRANT SELECT ON public_profiles TO authenticated, anon;
