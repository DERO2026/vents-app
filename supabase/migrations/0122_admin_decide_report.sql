-- Admin Console rebuild gap #2 (Reports): the previous "Approve/Dismiss"
-- action (AdminDashboardScreen.tsx's handleUpdateReport) was a bare client
-- UPDATE straight against public.reports -- no RPC, no admin_logs entry, no
-- explicit authorization check beyond whatever RLS already allowed. Any
-- admin/sub-admin action on a report was completely invisible in the audit
-- trail. This migration gives report decisions the same real, logged,
-- server-side path every other admin mutation already has.
--
-- Gated on is_admin() (root OR admin OR sub-admin), matching the previous
-- de-facto behavior (both tiers could already action/dismiss reports client-
-- side) -- this is a correctness/audit fix, not a permission change, and
-- does not need maker-checker dual control since it grants no capability
-- and moves no funds.
CREATE OR REPLACE FUNCTION public.admin_decide_report(p_report_id uuid, p_status text, p_reason text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF p_status NOT IN ('actioned', 'dismissed') THEN
    RAISE EXCEPTION 'Invalid status: % (allowed: actioned, dismissed)', p_status;
  END IF;

  UPDATE public.reports
     SET status = p_status
   WHERE id = p_report_id
     AND status = 'pending'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Report not found or already reviewed';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'decide_report',
    NULL,
    jsonb_build_object('report_id', p_report_id, 'status', p_status, 'reason', p_reason),
    public.actor_role()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_decide_report(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_report(uuid, text, text) TO authenticated, project_admin;
