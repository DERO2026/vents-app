-- Add ban_until column so bans can be temporary or permanent (NULL = permanent).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS banned_until timestamptz DEFAULT NULL;

-- Automatic reactivation: clear suspended status when banned_until has passed.
-- Called by a scheduled job (see below) and also checked at admin_update_users time.
CREATE OR REPLACE FUNCTION public.lift_expired_bans()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.users
  SET status = 'active', banned_until = NULL
  WHERE status = 'suspended'
    AND banned_until IS NOT NULL
    AND banned_until < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.lift_expired_bans() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lift_expired_bans() TO authenticated;
