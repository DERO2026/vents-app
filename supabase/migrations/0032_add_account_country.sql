-- Account/home country for the new signup flow (Choose Country -> Create
-- Account -> Email Verification -> Account Created -> Home, see
-- CountrySelectScreen.tsx / AuthScreen.tsx). Stored as ISO 3166-1 alpha-2
-- (e.g. 'NG', 'US'), matching CountryOption.iso in src/lib/countries.ts.
--
-- Deliberately metadata only, mirroring the existing `state` column: no
-- CHECK constraint restricting it to a known ISO list (same as `state`,
-- which has none either), and it is NOT referenced by select_events or any
-- other RLS policy -- event visibility/purchase has no country or state
-- predicate anywhere in this schema, confirmed before adding this column,
-- and this migration does not change that. A user's home country must never
-- become an access boundary; it only records where the account calls home
-- and gives the signup form's phone-country picker a sensible default.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS country text;

-- handle_new_user() (0025_signup_metadata_profile_fields.sql) already reads
-- the rest of the signup form out of auth.users.raw_user_meta_data at
-- INSERT time so the profile is complete from the moment the row exists,
-- independent of confirmation method/device -- same reasoning applies to
-- country: AuthScreen.tsx now includes it in signUp()'s options.data.
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

  BEGIN
    INSERT INTO public.users (id, email, role, full_name, username, phone_number, state, country, date_of_birth)
    VALUES (NEW.id, NEW.email, v_role, v_full_name, v_username, v_phone, v_state, v_country, v_dob);
  EXCEPTION WHEN unique_violation OR check_violation THEN
    INSERT INTO public.users (id, email, role)
    VALUES (NEW.id, NEW.email, v_role);
  END;

  RETURN NEW;
END;
$function$
;
