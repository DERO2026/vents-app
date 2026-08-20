-- Fix: signup profile data (full_name, username, phone_number, state,
-- date_of_birth) was lost during email confirmation.
--
-- Root cause: handle_new_user() (the trigger on auth.users that provisions
-- a public.users row on every signup) only ever inserted id/email/role. The
-- rest of the signup form depended entirely on a client-side follow-up
-- write succeeding -- which is impossible for the very case that matters
-- most: when email confirmation is required, supabase.auth.signUp()
-- returns no session, so the client has no auth.uid() and any attempt to
-- write the rest of the profile is rejected by RLS (users has no INSERT
-- policy for authenticated/anon, and its UPDATE policy requires
-- auth.uid() = id). A user who then confirms via the raw email link lands
-- authenticated with a bare profile -- full_name/username/phone/state all
-- NULL -- regardless of which browser/device/session they confirm in.
--
-- Fix: pass the signup form as auth.signUp()'s `options.data` (see
-- AuthScreen.tsx), which Supabase Auth stores in auth.users.raw_user_meta_data
-- immediately, as part of the signUp() call itself -- no session, no RLS,
-- no client follow-up required. This trigger now reads it directly at
-- INSERT time, so the profile is complete from the moment the row is
-- created, independent of confirmation method or device.
--
-- username is UNIQUE-constrained; the client already checks availability
-- before calling signUp() (check_user_exists), but this trigger fires
-- inside the same transaction as the auth.users INSERT, so a uniqueness
-- violation here would roll back signup entirely. Wrapped in an exception
-- handler that falls back to the pre-existing id/email/role-only insert on
-- any violation, so a race/edge case degrades to exactly today's shipped
-- behavior (profile completes later via the client-side path) rather than
-- breaking signup outright.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role text;
  v_full_name text;
  v_username text;
  v_phone text;
  v_state text;
  v_dob date;
BEGIN
  v_role := CASE
    WHEN NEW.raw_app_meta_data->>'role' = 'organizer' THEN 'organizer'
    ELSE 'attendee'
  END;

  v_full_name := NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), '');
  v_username  := NULLIF(trim(lower(NEW.raw_user_meta_data->>'username')), '');
  v_phone     := NULLIF(trim(NEW.raw_user_meta_data->>'phone_number'), '');
  v_state     := NULLIF(trim(NEW.raw_user_meta_data->>'state'), '');
  BEGIN
    v_dob := NULLIF(NEW.raw_user_meta_data->>'date_of_birth', '')::date;
  EXCEPTION WHEN OTHERS THEN
    v_dob := NULL;
  END;

  BEGIN
    INSERT INTO public.users (id, email, role, full_name, username, phone_number, state, date_of_birth)
    VALUES (NEW.id, NEW.email, v_role, v_full_name, v_username, v_phone, v_state, v_dob);
  EXCEPTION WHEN unique_violation OR check_violation THEN
    INSERT INTO public.users (id, email, role)
    VALUES (NEW.id, NEW.email, v_role);
  END;

  RETURN NEW;
END;
$function$
;
