-- SECURITY DEFINER function for admin to broadcast a notification to all non-deleted users.
-- Bypasses the insert_notifications RLS policy (which restricts user_id = auth.uid()).

CREATE OR REPLACE FUNCTION public.admin_broadcast(p_title text, p_body text, p_type text DEFAULT 'system')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_role text;
  v_count integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_caller_role FROM public.users WHERE id = v_caller_id;
  IF v_caller_role != 'admin' THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  INSERT INTO public.notifications (user_id, title, body, type)
  SELECT id, p_title, p_body, p_type
  FROM public.users
  WHERE status != 'deleted';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_broadcast(text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_broadcast(text, text, text) FROM anon;
