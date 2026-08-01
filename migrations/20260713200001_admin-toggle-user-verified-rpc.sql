-- Reconciliation, not a new change: this migration was applied directly to
-- production (visible in production's migration ledger, createdAt
-- 2026-07-13T08:09:11Z) but its file was never committed to the repo —
-- confirmed via full git history search: no file or commit for this
-- version or function name exists anywhere in git log --all. Recreating
-- the file here verbatim from the live definition so the repo's migration
-- history matches what's actually running in production. Not re-applying
-- anything new — the function has been live since 2026-07-13.
CREATE OR REPLACE FUNCTION public.admin_toggle_user_verified(p_user_id uuid, p_verified boolean, p_reason text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_old_verified boolean;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin verification cannot be changed';
  END IF;

  SELECT is_verified INTO v_old_verified FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  UPDATE public.users SET is_verified = p_verified WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'toggle_verification',
    p_user_id,
    jsonb_build_object('old_verified', v_old_verified, 'new_verified', p_verified, 'reason', p_reason),
    public.actor_role()
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_toggle_user_verified TO authenticated;
