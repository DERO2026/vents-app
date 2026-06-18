-- ── 1. Restrict select_users: full row only for own row ──────────────────────
DROP POLICY IF EXISTS select_users ON public.users;

CREATE POLICY select_own_user ON public.users
  FOR SELECT
  USING (id = (SELECT auth.uid()));

-- ── 2. Public profiles view: safe fields only ─────────────────────────────────
CREATE OR REPLACE VIEW public.public_profiles AS
  SELECT
    id,
    full_name,
    username,
    avatar_url,
    is_verified,
    state
  FROM public.users;

-- Grant authenticated users read access to the view
GRANT SELECT ON public.public_profiles TO authenticated;

-- ── 3. SECURITY DEFINER helpers for auth flows ────────────────────────────────
-- Used by signup to check if email/phone/username is already taken
-- without exposing any row data to the caller.
CREATE OR REPLACE FUNCTION public.check_user_exists(
  p_email       text DEFAULT NULL,
  p_phone       text DEFAULT NULL,
  p_username    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb := '{}';
BEGIN
  IF p_email IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'email_taken',
      EXISTS (SELECT 1 FROM public.users WHERE email = lower(trim(p_email)))
    );
  END IF;
  IF p_phone IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'phone_taken',
      EXISTS (SELECT 1 FROM public.users WHERE phone_number = trim(p_phone))
    );
  END IF;
  IF p_username IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'username_taken',
      EXISTS (SELECT 1 FROM public.users WHERE username = lower(trim(p_username)))
    );
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.check_user_exists(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_user_exists(text, text, text) TO authenticated, anon;

-- Used by login: resolve username → email without exposing the email to SELECT
CREATE OR REPLACE FUNCTION public.resolve_username_to_email(p_username text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email
  FROM public.users
  WHERE username = lower(trim(p_username))
  LIMIT 1;
  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_username_to_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_username_to_email(text) TO anon, authenticated;

-- Used by password reset: confirm email exists without exposing id
CREATE OR REPLACE FUNCTION public.email_exists(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users WHERE email = lower(trim(p_email))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.email_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.email_exists(text) TO anon, authenticated;
