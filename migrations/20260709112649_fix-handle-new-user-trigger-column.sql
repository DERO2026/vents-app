-- EMERGENCY HOTFIX: handle_new_user() referenced NEW.raw_user_meta_data, a
-- column that does not exist on this project's auth.users table (it has
-- `metadata` instead — this trigger was apparently written against a
-- Supabase-style auth.users schema and never actually matched this
-- project's schema). Every signUp() call inserts into auth.users, which
-- fires this AFTER INSERT trigger; the trigger threw
-- 'record "new" has no field "raw_user_meta_data"', which rolled back the
-- entire insert transaction — meaning every single signup attempt failed
-- at the database layer, 100% of the time. This was being silently
-- swallowed by AuthScreen.tsx's generic "Signup failed" fallback message
-- with no console logging, which is why it went undiagnosed.
--
-- AuthScreen.tsx never actually passes metadata/role through signUp() —
-- it does an explicit follow-up upsert into public.users with the full
-- profile (including role) immediately after signUp() succeeds, so this
-- trigger's CASE on a role in metadata was already effectively dead output
-- from the client's perspective. Fixing the column reference preserves the
-- trigger's original intent (seed a base row so the client's follow-up
-- upsert and the profile-polling loop have something to work against)
-- without changing its behavior in practice.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text;
BEGIN
  v_role := CASE
    WHEN NEW.metadata->>'role' = 'organizer' THEN 'organizer'
    ELSE 'attendee'
  END;
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, v_role);
  RETURN NEW;
END;
$function$;
