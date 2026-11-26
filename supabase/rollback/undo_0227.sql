-- Undo 0227 (auth lookup hardening). Gated: run with
--   SET vents.rollback_confirm = 'undo-0227';
-- Restores the exact pre-0227 bodies of reclaim_unverified_signup (0004)
-- and check_user_exists (0027), drops the new login lookups, the internal
-- password check and the email-column trigger, and re-grants email_exists
-- to anon/authenticated exactly as 0011 did.
-- Refuses while 0228 is applied (run undo_0228 first), so username login is
-- never left with neither the new nor the old lookup.
-- WARNING: this re-opens L4/M8/L5. Revert the client (AuthScreen) BEFORE
-- running it: the current client calls resolve_login_email.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0227' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0227'' first';
  END IF;
  IF NOT has_function_privilege('anon', 'public.resolve_username_to_email(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Refusing: 0228 is applied; run undo_0228 first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.reclaim_unverified_signup(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_username text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  WITH stale AS (
    SELECT au.id
    FROM auth.users au
    JOIN public.users u ON u.id = au.id
    WHERE au.email_confirmed_at IS NULL
      AND au.created_at < now() - interval '3 minutes'
      AND (
        (p_email IS NOT NULL AND u.email = lower(trim(p_email)))
        OR (p_phone IS NOT NULL AND trim(p_phone) <> '' AND u.phone_number = trim(p_phone))
        OR (p_username IS NOT NULL AND u.username = lower(trim(p_username)))
      )
  ), deleted AS (
    DELETE FROM auth.users WHERE id IN (SELECT id FROM stale) RETURNING id
  )
  SELECT count(*) INTO v_count FROM deleted;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_user_exists(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_username text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb := '{}';
BEGIN
  IF p_email IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'email_taken',
      EXISTS (
        SELECT 1 FROM auth.users au
        WHERE au.email = lower(trim(p_email)) AND au.email_confirmed_at IS NOT NULL
      )
    );
  END IF;
  IF p_phone IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'phone_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.phone_number = trim(p_phone) AND au.email_confirmed_at IS NOT NULL
      )
    );
  END IF;
  IF p_username IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'username_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.username = lower(trim(p_username)) AND au.email_confirmed_at IS NOT NULL
      )
    );
  END IF;
  RETURN v_result;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_user_email_columns ON public.users;
DROP FUNCTION IF EXISTS public.protect_user_email_columns();
DROP FUNCTION IF EXISTS public.get_login_account_status(text, text);
DROP FUNCTION IF EXISTS public.resolve_login_email(text, text);
DROP FUNCTION IF EXISTS public.login_password_matches(uuid, text);

GRANT EXECUTE ON FUNCTION public.email_exists(p_email text) TO anon, authenticated, project_admin;
COMMIT;
