-- Two production fixes shipped together because they touch the same
-- handle_new_user() signup path:
--
-- 1. Account/home country column. 0032_add_account_country.sql was authored
--    and committed but, per direct inspection of production
--    (information_schema.columns / pg_get_functiondef), was NEVER actually
--    applied: public.users has no `country` column and the live
--    handle_new_user() has no country handling at all. Meanwhile
--    AuthScreen.tsx has shipped for a while writing `country` into both
--    signUp()'s raw_user_meta_data and a later profile-completion
--    `.from('users').update(...)` call, which is exactly the PGRST204
--    "Could not find the 'country' column of 'users' in the schema cache"
--    error seen in production Sentry issue JAVASCRIPT-REACT-1V. This section
--    completes that already-designed, already-reviewed migration rather than
--    blindly bolting on a column: same ALTER TABLE, same reasoning (metadata
--    only, never an RLS/access boundary, mirrors the existing `state`
--    column).
-- 2. Default signup role. VENTS no longer has a distinct "attendee" role --
--    every account starts as a normal 'user' and independently gains the
--    organizer and/or service-provider capability (is_service_provider is
--    already a separate boolean column, untouched here). 'user' is already
--    an allowed value of users_role_check, so this is a default-value/
--    validation change only, not a schema/constraint change.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS country text;

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
    ELSE 'user'
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

-- Both functions below are reproduced verbatim from their live production
-- definitions (captured via pg_get_functiondef immediately before writing
-- this migration) with ONLY the role-string allow-list (and, in
-- admin_set_user_role, the error message text that names it) changed from
-- 'attendee' to 'user'. Every other line -- is_super_admin()/is_root()
-- gating, the Root-uid guard, the admin_logs audit insert, actor_role() --
-- is untouched.
CREATE OR REPLACE FUNCTION public.set_signup_role(p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_current_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_role NOT IN ('organizer', 'user') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT role INTO v_current_role FROM public.users WHERE id = v_id;
  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  UPDATE public.users SET role = p_role WHERE id = v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target_role text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  IF p_new_role = 'sub-admin' THEN
    IF NOT public.is_root() THEN
      RAISE EXCEPTION 'Only Root can assign the Sub-Admin role';
    END IF;
  ELSIF p_new_role NOT IN ('user', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: user, organizer, sub-admin [Root only])', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object('old_role', v_target_role, 'new_role', p_new_role),
    public.actor_role()
  );
END;
$function$
;
