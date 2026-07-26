-- ── Stop abandoned/unverified signups from permanently blocking an email ─────
-- check_user_exists() flagged email/phone/username as "taken" for ANY matching
-- row in public.users, regardless of whether the linked auth.users row was ever
-- verified. A user who starts signing up and never confirms their email (closes
-- the tab, mistypes, never receives the mail) permanently locks that email out
-- of ever signing up again — the real bug being reported.
--
-- Fix has two parts:
--   1. check_user_exists() now only reports "taken" for a VERIFIED account.
--      An abandoned, unverified row no longer blocks a fresh signup attempt.
--   2. reclaim_unverified_signup() actively deletes the stale unverified row
--      (cascades from auth.users -> public.users -> its dependents) so the
--      platform's own auth.users email-uniqueness constraint doesn't reject
--      the new insforge.auth.signUp() call that follows. Only ever deletes
--      rows that are BOTH unverified AND older than a short grace window, so
--      it can never touch a real/verified account or race a signup that is
--      still in flight.

CREATE OR REPLACE FUNCTION public.check_user_exists(
  p_email text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text,
  p_username text DEFAULT NULL::text
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb := '{}';
BEGIN
  IF p_email IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'email_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.email = lower(trim(p_email)) AND au.email_verified = true
      )
    );
  END IF;
  IF p_phone IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'phone_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.phone_number = trim(p_phone) AND au.email_verified = true
      )
    );
  END IF;
  IF p_username IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'username_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.username = lower(trim(p_username)) AND au.email_verified = true
      )
    );
  END IF;
  RETURN v_result;
END;
$function$;

-- Deletes any unverified, sufficiently-aged account that collides with the
-- email/phone/username the caller is about to sign up with. Called by the
-- client immediately before insforge.auth.signUp(). Safe by construction:
--   - email_verified = false is required — a verified account is NEVER
--     touched no matter what matches.
--   - created_at < now() - 3 minutes guards against deleting a row that a
--     concurrent/in-flight signup (including the caller's own retry) just
--     created moments ago.
--   - Deleting auth.users cascades to public.users and its dependents
--     (users_id_fkey is ON DELETE CASCADE), so this fully reclaims the slot.
-- Runs as SECURITY DEFINER because the caller isn't authenticated yet (this
-- happens before signUp) — deliberately scoped to unverified+stale rows only,
-- so it can never be used to delete a real account regardless of who calls it.
CREATE OR REPLACE FUNCTION public.reclaim_unverified_signup(
  p_email text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text,
  p_username text DEFAULT NULL::text
) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  WITH stale AS (
    SELECT au.id
    FROM auth.users au
    JOIN public.users u ON u.id = au.id
    WHERE au.email_verified = false
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

ALTER FUNCTION public.check_user_exists(text, text, text) SET search_path = '';
ALTER FUNCTION public.reclaim_unverified_signup(text, text, text) SET search_path = '';
GRANT EXECUTE ON FUNCTION public.check_user_exists(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_unverified_signup(text, text, text) TO anon, authenticated;
