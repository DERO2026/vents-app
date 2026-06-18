-- Allow attendees to self-promote to organizer via a SECURITY DEFINER function
-- that bypasses the trg_check_user_role_update trigger restriction.

CREATE OR REPLACE FUNCTION public.promote_to_organizer()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_id;

  -- Only allow promotion from attendee/user; block admin escalation
  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  -- Directly update bypassing the trigger restriction for attendee->organizer
  UPDATE public.users SET role = 'organizer' WHERE id = v_id;
END;
$$;

-- Grant execute to authenticated users only
GRANT EXECUTE ON FUNCTION public.promote_to_organizer() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.promote_to_organizer() FROM anon;
