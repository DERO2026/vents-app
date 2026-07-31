-- admin_suspend_user / admin_soft_delete_user already blocked acting on the
-- hardcoded Root account, but never blocked a Super Admin acting on
-- themselves. A Super Admin (or a compromised admin session) could
-- self-suspend or self-soft-delete, locking themselves out with no
-- self-service recovery path — would need Root or another Super Admin to
-- reinstate them.
CREATE OR REPLACE FUNCTION public.admin_suspend_user(p_user_id uuid, p_banned_until timestamp with time zone, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none'); END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be suspended'; END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot suspend your own account'; END IF;
  UPDATE public.users SET status = 'suspended', banned_until = p_banned_until WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'suspend_user', p_user_id, jsonb_build_object('banned_until', p_banned_until, 'reason', p_reason), public.actor_role());
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be deleted'; END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot delete your own account this way — use Settings > Delete Account instead'; END IF;
  UPDATE public.users SET status = 'deleted', deleted_at = now(), deleted_by = auth.uid(), reason = p_reason WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'delete_user', p_user_id, jsonb_build_object('reason', p_reason), public.actor_role());
END;
$function$;
