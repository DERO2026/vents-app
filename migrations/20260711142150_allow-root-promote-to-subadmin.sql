-- Allow Root (and only Root) to promote a user to 'sub-admin' via
-- admin_set_user_role, so a demoted Sub-Admin can be re-promoted. Everyone
-- else (including Sub-Admins themselves) is still restricted to
-- attendee/organizer — no path exists for a Sub-Admin to self-escalate or
-- create new admin-tier accounts.
CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target_role text;
  v_caller_role text;
  v_is_root boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  v_is_root := auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

  IF p_new_role = 'sub-admin' THEN
    IF NOT v_is_root THEN
      RAISE EXCEPTION 'Only Root can assign the Sub-Admin role';
    END IF;
  ELSIF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer, sub-admin [Root only])', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;
  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();

  IF v_target_role IN ('admin', 'sub-admin') AND v_caller_role = 'sub-admin' THEN
    RAISE EXCEPTION 'Sub-Admins cannot alter Admin/Sub-Admin accounts';
  END IF;

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
$function$;
