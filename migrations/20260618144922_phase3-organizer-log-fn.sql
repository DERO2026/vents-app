-- SECURITY DEFINER function to write organizer promotion logs.
-- Non-admins can't INSERT into admin_logs directly (RLS blocks it), so we
-- wrap the write in a definer function that runs as the table owner.
-- Guard: the calling user must actually be an organizer in users.role.

CREATE OR REPLACE FUNCTION public.log_organizer_promotion(
  p_user_id UUID,
  p_email    TEXT,
  p_username TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only write if the caller really is the target and is an organizer
  IF auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'caller must be the target user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND role IN ('organizer', 'organiser')
  ) THEN
    RAISE EXCEPTION 'user is not an organizer';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (
    p_user_id,
    'organizer_promoted',
    p_user_id,
    jsonb_build_object(
      'email',       p_email,
      'username',    p_username,
      'promoted_at', now()
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_organizer_promotion(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_organizer_promotion(UUID, TEXT, TEXT) TO authenticated;
