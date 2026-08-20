-- Fix: check_user_exists()'s email check went through public.users JOIN
-- auth.users, so it was blind to any case where auth.users has a confirmed
-- account but public.users doesn't have a matching row (e.g. the profile
-- row was deleted directly -- via the Supabase dashboard, admin tooling, or
-- any future bug -- bypassing delete_own_account(), which correctly renames
-- the email away in both tables). In that state, a real user retrying
-- signup with their original email got no "email already exists" error
-- (the join found nothing), so the app called supabase.auth.signUp()
-- against an email Auth already considers registered and confirmed --
-- which Supabase deliberately no-ops (sends zero email, returns a
-- success-shaped response) to prevent account-enumeration attacks. The
-- user landed on the OTP entry screen for a code that was never sent, with
-- no error explaining why.
--
-- Fix: check auth.users directly for the email (it's a native auth.users
-- column, independent of public.users' state) instead of joining through
-- public.users. phone_taken/username_taken are correctly left as-is --
-- phone_number and username only exist in public.users, there's no
-- auth-level equivalent to check them against.
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
$function$
;
