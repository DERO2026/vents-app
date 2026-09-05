-- Fixes the "new users appear incomplete in Admin Console" bug.
--
-- ROOT CAUSE (traced end-to-end: auth account creation -> users row
-- creation -> profile persistence -> Admin Console query/render):
-- handle_new_user() (0032_add_account_country.sql) inserted every signup
-- field in ONE combined INSERT, wrapped in a single exception handler:
--
--   BEGIN
--     INSERT INTO public.users (id, email, role, full_name, username,
--       phone_number, state, country, date_of_birth) VALUES (...);
--   EXCEPTION WHEN unique_violation OR check_violation THEN
--     INSERT INTO public.users (id, email, role) VALUES (...);
--   END;
--
-- public.users has UNIQUE constraints on BOTH username and phone_number
-- (0005_primary_unique_check_constraints.sql). If EITHER collides (most
-- plausibly a reused test phone number in Preview, or a narrow race
-- against the client's own pre-signup check_user_exists check), the
-- fallback silently discards full_name, username, phone_number, state,
-- country, AND date_of_birth entirely -- not just the one field that
-- actually collided. AuthScreen.tsx's post-signup completion step
-- (fetchProfileAndSucceed) tries to backfill via a client-side UPDATE, but
-- that can hit the exact same collision, and its error is only logged
-- (console.error/Sentry), never surfaced or blocking the signup from
-- "succeeding" client-side -- so the user's own session shows a complete
-- profile (built from local form state) while the actual DB row, which is
-- what Admin Console queries and displays, stays id/email/role only.
--
-- Confirmed NOT the cause (ruled out during the trace): Admin Console's
-- own Users-tab query is a plain, correct select -- it only ever displays
-- what's actually in the row. delete_own_account() already clears
-- username/phone_number/email on deletion, so this isn't caused by a
-- stale deleted account permanently blocking reuse. No CHECK constraints
-- exist on any of these columns, so unique_violation (username or
-- phone_number) is the only realistic trigger for the fallback branch.
--
-- FIX: split the single all-or-nothing insert into (1) a base insert with
-- every field that has NO unique constraint (full_name, state, country,
-- date_of_birth -- these can never collide and should never be lost), and
-- (2) independent per-field backfills for username and phone_number, each
-- with its OWN exception handler -- so a collision on one no longer wipes
-- out the other or any of the always-safe fields. A field that genuinely
-- collides is still correctly left unset (you cannot assign a duplicate
-- username/phone; that constraint is doing its job) -- but this is now
-- the ONLY field an admin will see missing, not the entire profile.
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
  v_country text;
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
  v_country   := NULLIF(trim(NEW.raw_user_meta_data->>'country'), '');
  BEGIN
    v_dob := NULLIF(NEW.raw_user_meta_data->>'date_of_birth', '')::date;
  EXCEPTION WHEN OTHERS THEN
    v_dob := NULL;
  END;

  -- Base insert: only columns with no unique constraint, so this step
  -- itself can never fail on a collision.
  INSERT INTO public.users (id, email, role, full_name, state, country, date_of_birth)
  VALUES (NEW.id, NEW.email, v_role, v_full_name, v_state, v_country, v_dob);

  -- username: independent backfill. A collision here leaves ONLY username
  -- unset -- full_name/state/country/date_of_birth above are unaffected.
  IF v_username IS NOT NULL THEN
    BEGIN
      UPDATE public.users SET username = v_username WHERE id = NEW.id;
    EXCEPTION WHEN unique_violation THEN
      -- Genuinely taken -- correctly left unset. AuthScreen.tsx's own
      -- pre-signup check_user_exists RPC is what should normally catch
      -- this before signUp() is even called; this is the narrow-race/
      -- defense-in-depth path.
      NULL;
    END;
  END IF;

  -- phone_number: same independent-backfill treatment, same reasoning.
  IF v_phone IS NOT NULL THEN
    BEGIN
      UPDATE public.users SET phone_number = v_phone WHERE id = NEW.id;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END IF;

  RETURN NEW;
END;
$function$
;
