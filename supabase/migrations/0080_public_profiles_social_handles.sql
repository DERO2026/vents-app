-- Surface the new per-user social handles (0079) through the public
-- profile view so other users' Connected Accounts render on organizer
-- profiles. RETURNS TABLE signature is changing, so the function must be
-- dropped before being recreated (CREATE OR REPLACE can't change the
-- return column list); the dependent view is dropped and recreated too.

DROP VIEW IF EXISTS public.public_profiles;
DROP FUNCTION IF EXISTS public.get_public_profiles();

CREATE FUNCTION public.get_public_profiles()
 RETURNS TABLE(id uuid, full_name text, username text, avatar_url text, cover_url text, is_verified boolean, state text, role text, interests text[], bio text, vc_badge text, last_active_at timestamp with time zone, instagram_handle text, x_handle text, tiktok_handle text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
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
    last_active_at,
    instagram_handle,
    x_handle,
    tiktok_handle
  FROM public.users
  WHERE deleted_at IS NULL;
$function$
;

CREATE VIEW public.public_profiles AS
  SELECT * FROM public.get_public_profiles() AS get_public_profiles(
    id, full_name, username, avatar_url, cover_url, is_verified, state,
    role, interests, bio, vc_badge, last_active_at,
    instagram_handle, x_handle, tiktok_handle
  );

-- Restore the exact final grant state from 0011/0013/0026: SELECT-only for
-- anon/authenticated on the view (no INSERT/UPDATE/DELETE -- it's backed
-- by a SECURITY DEFINER function, not a real writable relation), full
-- access for project_admin, and EXECUTE-only on the function itself.
REVOKE ALL ON FUNCTION public.get_public_profiles() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_public_profiles() TO anon, authenticated, project_admin;

REVOKE ALL ON public.public_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.public_profiles TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.public_profiles TO project_admin;
