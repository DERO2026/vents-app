-- Replace view with a SECURITY DEFINER set-returning function.
-- The function runs as its owner (which has superuser rights to bypass users RLS)
-- and returns only safe public fields. The view is dropped; code queries
-- the function directly.

DROP VIEW IF EXISTS public.public_profiles;

-- Re-create as a SECURITY DEFINER function that bypasses users RLS
CREATE OR REPLACE FUNCTION public.get_public_profiles()
RETURNS TABLE (
  id          uuid,
  full_name   text,
  username    text,
  avatar_url  text,
  is_verified boolean,
  state       text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, full_name, username, avatar_url, is_verified, state
  FROM public.users;
$$;

REVOKE ALL ON FUNCTION public.get_public_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_profiles() TO authenticated;

-- Thin view over the function so PostgREST / SDK .from('public_profiles') still works
CREATE OR REPLACE VIEW public.public_profiles AS
  SELECT * FROM public.get_public_profiles();

GRANT SELECT ON public.public_profiles TO authenticated;

