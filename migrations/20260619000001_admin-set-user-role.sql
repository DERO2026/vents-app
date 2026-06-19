-- Item 3: admin_set_user_role — SECURITY DEFINER, admin-only, supports promote & downgrade.
-- Root UID (c9eb5eb6...) is permanently protected at the DB trigger level.

-- Step 1: Modify check_user_role_update to allow override from SECURITY DEFINER admin functions.
-- Inside a SECURITY DEFINER function, current_user becomes the function owner (e.g. postgres),
-- not 'authenticated'. The trigger uses this to allow admin-initiated role changes.
CREATE OR REPLACE FUNCTION public.check_user_role_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- SECURITY DEFINER admin functions run as the function owner, not as 'authenticated'.
  -- Allow them to bypass the normal role-change restrictions.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Never allow escalation to admin via normal update.
  IF NEW.role = 'admin' AND (OLD.role IS DISTINCT FROM 'admin') THEN
    RAISE EXCEPTION 'Cannot escalate role to admin';
  END IF;

  -- Block downgrade: once organizer, cannot revert to attendee/user.
  IF OLD.role IN ('organizer', 'organiser') AND NEW.role NOT IN ('organizer', 'organiser', 'admin') THEN
    RAISE EXCEPTION 'Organizer role cannot be downgraded';
  END IF;

  RETURN NEW;
END;
$$;

-- Step 2: Create admin_set_user_role.
CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  p_user_id  uuid,
  p_new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
  v_target_role text;
BEGIN
  -- Caller must be admin.
  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins can change user roles';
  END IF;

  -- Validate new role.
  IF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer)', p_new_role;
  END IF;

  -- Root UID is immutable (also enforced by trg_lock_admin_root_role trigger).
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  -- Fetch current role for audit log.
  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

  -- Update — trigger will allow this because current_user = function owner (not 'authenticated').
  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  -- Write audit log.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object(
      'old_role', v_target_role,
      'new_role', p_new_role
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, text) TO authenticated;

-- Step 3: get_account_status — lets login flow detect suspended/deleted accounts
-- even when the auth layer returns an error (wrong password etc.).
CREATE OR REPLACE FUNCTION public.get_account_status(p_email text)
RETURNS TABLE(status text, banned_until timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT status, banned_until
  FROM public.users
  WHERE lower(email) = lower(p_email)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_account_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_account_status(text) TO anon, authenticated;
