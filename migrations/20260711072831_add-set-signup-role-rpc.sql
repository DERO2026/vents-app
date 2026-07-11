-- Fix: the role a user picks (Attendee/Organizer) before signing up was
-- silently discarded whenever they picked Organizer.
--
-- Root cause: handle_new_user() (migrations/20260709112649_...) inserts the
-- public.users row synchronously during signUp(), always defaulting role to
-- 'attendee' (insforge.auth.signUp() has no metadata field for the SDK to
-- carry the selected role through). The frontend's later attempt to correct
-- the role to 'organizer' is a plain UPDATE, which
-- check_user_role_update() (migrations/20260619000004_block-direct-role-change.sql)
-- rejects outright for any authenticated-role caller where OLD.role differs
-- from NEW.role — that trigger only allows role changes from a
-- SECURITY DEFINER function (e.g. the existing promote_to_organizer()).
-- The frontend's write was fire-and-forget / had its error discarded, so
-- this failure was completely invisible: the session looked correct
-- (client-side optimistic value) until the next login re-read the real,
-- unchanged 'attendee' row.
--
-- Fix: give signup the same SECURITY DEFINER bypass promote_to_organizer()
-- already uses for the same trigger.
CREATE OR REPLACE FUNCTION public.set_signup_role(p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_current_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_role NOT IN ('organizer', 'attendee') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT role INTO v_current_role FROM public.users WHERE id = v_id;
  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  UPDATE public.users SET role = p_role WHERE id = v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.set_signup_role(text) TO authenticated;
