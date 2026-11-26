-- 0227: login and sign-up lookups stop exposing account data
-- (H2, M8, L4, L5 in docs/repair-tracker.md).
--
-- H2  resolve_username_to_email (anon) returned ANY account's email for its
--     public username, with no rate limit: every user's email could be
--     harvested. Replaced, for login, by resolve_login_email(username,
--     password), which returns the email only when the password is also
--     correct (so it tells a caller nothing they could not already sign in
--     with). Rate limited per username and per IP. Sign-in itself still runs
--     on the user's device against Supabase Auth, so Auth's own per-IP
--     limits and lockouts keep applying to the real client.
-- L4  get_account_status(email) (anon) told anyone whether any email's
--     account is suspended or deleted. Replaced by
--     get_login_account_status(identifier, password): answers only for the
--     account's owner (correct password), and only says suspended/deleted.
--     email_exists (anon, unused by the app) is revoked. check_user_exists
--     (needed by sign-up) is now rate limited per IP.
-- M8  reclaim_unverified_signup (anon) deleted any unconfirmed sign-up older
--     than 3 minutes matching an email, phone OR username, so a stranger
--     could wipe someone's in-progress sign-up. It now only reclaims a
--     sign-up older than 1 hour (the default lifetime of a Supabase email
--     code, after which that sign-up could not be completed anyway) and is
--     rate limited per IP. A same-person retry within the hour already goes
--     to the "enter your code / resend" screen (duplicateSignupEmail.ts).
-- L5  public.users.email / original_email could be edited by the user and
--     drift from the login email. Client roles can no longer change them;
--     database functions (account deletion, email release) still can.
--
-- Existing functions are patched IN PLACE from their live definitions: each
-- anchor must match exactly once or the whole migration refuses (one
-- transaction). Grants on the patched functions are unchanged.
--
-- 0227 is safe for every installed app build: it only ADDS the new lookups
-- and hardens the rest. Closing H2 fully needs 0228 (revokes the old
-- resolve_username_to_email and get_account_status from clients), applied
-- once this app version is live and old native builds are updated: an old
-- build would lose username login (email login keeps working).
-- Undo: supabase/rollback/undo_0227.sql (after undo_0228 if 0228 is applied).

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.resolve_username_to_email(text)') IS NULL
     OR to_regprocedure('public.get_account_status(text)') IS NULL
     OR to_regprocedure('public.reclaim_unverified_signup(text,text,text)') IS NULL
     OR to_regprocedure('public.check_user_exists(text,text,text)') IS NULL
     OR to_regprocedure('public.email_exists(text)') IS NULL
     OR to_regprocedure('public.check_rate_limit(text,integer,integer)') IS NULL
     OR to_regprocedure('public.client_ip()') IS NULL THEN
    RAISE EXCEPTION '0227: an expected auth helper is missing; refusing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION pg_temp.vents_0227_patch(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  IF position('[0227]' IN v_def) > 0 THEN
    RAISE EXCEPTION '0227: % is already patched; refusing to run twice', p_sig;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION '0227: % is not the expected version (anchor % not found exactly once); refusing to patch', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

-- ── M8: reclaim only sign-ups that can no longer be completed; rate limit.
SELECT pg_temp.vents_0227_patch('public.reclaim_unverified_signup(text,text,text)', ARRAY[
  ARRAY[$a$BEGIN
  WITH stale AS ($a$, $a$BEGIN
  -- [0227] Rate limited per IP, and only a sign-up older than 1 hour (an
  -- email code's default lifetime) is reclaimed, so nobody can wipe a
  -- sign-up that is still being completed.
  PERFORM public.check_rate_limit('auth:reclaim:ip:' || COALESCE(public.client_ip(), 'unknown'), 10, 300);
  WITH stale AS ($a$],
  ARRAY[$a$AND au.created_at < now() - interval '3 minutes'$a$, $a$AND au.created_at < now() - interval '1 hour'$a$]
]);

-- ── L4: sign-up's availability check stays, rate limited per IP.
SELECT pg_temp.vents_0227_patch('public.check_user_exists(text,text,text)', ARRAY[
  ARRAY[$a$BEGIN
  IF p_email IS NOT NULL THEN$a$, $a$BEGIN
  -- [0227] Rate limited per IP so it cannot be used to enumerate accounts.
  PERFORM public.check_rate_limit('auth:exists:ip:' || COALESCE(public.client_ip(), 'unknown'), 60, 300);
  IF p_email IS NOT NULL THEN$a$]
]);

-- ── Password check against Supabase Auth's own bcrypt hash (pgcrypto's
-- crypt() verifies $2a$/$2b$ hashes). Internal only: never granted to clients.
DO $mk$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
  IF v_schema IS NULL THEN
    RAISE EXCEPTION '0227: pgcrypto is not installed; refusing';
  END IF;
  EXECUTE format($f$
CREATE FUNCTION public.login_password_matches(p_user uuid, p_password text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $b$
  SELECT EXISTS (
    SELECT 1 FROM auth.users au
     WHERE au.id = p_user
       AND p_password IS NOT NULL AND p_password <> ''
       AND au.encrypted_password IS NOT NULL AND au.encrypted_password <> ''
       AND %1$I.crypt(p_password, au.encrypted_password) = au.encrypted_password
  );
$b$;$f$, v_schema);
END
$mk$;
REVOKE ALL ON FUNCTION public.login_password_matches(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── H2: username login. Same account the old lookup picked (case-insensitive
-- username, oldest account wins, as 0049), but returns its LOGIN email and
-- only with the right password; NULL otherwise (no account / wrong password
-- look the same).
CREATE FUNCTION public.resolve_login_email(p_username text, p_password text)
 RETURNS text
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user uuid;
  v_email text;
BEGIN
  IF p_username IS NULL OR btrim(p_username) = '' OR p_password IS NULL OR p_password = '' THEN
    RETURN NULL;
  END IF;
  PERFORM public.check_rate_limit('auth:login_lookup:id:' || lower(btrim(p_username)), 5, 300);
  PERFORM public.check_rate_limit('auth:login_lookup:ip:' || COALESCE(public.client_ip(), 'unknown'), 20, 300);

  SELECT u.id, au.email INTO v_user, v_email
    FROM public.users u
    JOIN auth.users au ON au.id = u.id
   WHERE lower(btrim(u.username)) = lower(btrim(p_username))
   ORDER BY u.created_at ASC
   LIMIT 1;
  IF v_user IS NULL OR NOT public.login_password_matches(v_user, p_password) THEN
    RETURN NULL;
  END IF;
  RETURN v_email;
END;
$function$;

-- ── L4: after a failed sign-in, tell the OWNER (right password) that their
-- account is suspended or deleted. Anyone else, or an active account, gets
-- no rows.
CREATE FUNCTION public.get_login_account_status(p_identifier text, p_password text)
 RETURNS TABLE(status text, banned_until timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user uuid;
  v_id text := lower(btrim(COALESCE(p_identifier, '')));
BEGIN
  IF v_id = '' OR p_password IS NULL OR p_password = '' THEN
    RETURN;
  END IF;
  PERFORM public.check_rate_limit('auth:status_lookup:id:' || v_id, 5, 300);
  PERFORM public.check_rate_limit('auth:status_lookup:ip:' || COALESCE(public.client_ip(), 'unknown'), 20, 300);

  IF position('@' IN v_id) > 0 THEN
    SELECT au.id INTO v_user FROM auth.users au WHERE lower(au.email) = v_id LIMIT 1;
  ELSE
    SELECT u.id INTO v_user FROM public.users u WHERE lower(btrim(u.username)) = v_id ORDER BY u.created_at ASC LIMIT 1;
  END IF;
  IF v_user IS NULL OR NOT public.login_password_matches(v_user, p_password) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT u.status, u.banned_until FROM public.users u
     WHERE u.id = v_user AND u.status IN ('suspended', 'deleted');
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_login_email(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_login_email(text, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_login_account_status(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_login_account_status(text, text) TO anon, authenticated;

-- ── L4: email_exists is unused by every app build; server-only from now on.
-- (resolve_username_to_email and get_account_status are revoked by 0228,
-- separately: installed native app builds still call them, see 0228.)
REVOKE EXECUTE ON FUNCTION public.email_exists(text) FROM PUBLIC, anon, authenticated;

-- ── L5: the account's email columns follow the login email; clients can't
-- edit them. SECURITY DEFINER functions (run as their owner) still can.
CREATE FUNCTION public.protect_user_email_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.email IS DISTINCT FROM OLD.email OR NEW.original_email IS DISTINCT FROM OLD.original_email) THEN
    RAISE EXCEPTION 'Your email is changed in account settings, not on your profile';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_protect_user_email_columns
  BEFORE UPDATE OF email, original_email ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.protect_user_email_columns();

COMMIT;
