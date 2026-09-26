-- Batch 1b (1/3) — Event featuring: move authorization into the RPC.
--
-- ROOT CAUSE. admin_set_event_featured gated on is_admin(), which is
-- `is_root() OR role IN ('admin','sub-admin')` -- i.e. it admitted
-- Sub-Admins. Featuring an event grants prime placement in the discovery
-- feed, monetary-equivalent value the platform otherwise sells. A Sub-Admin
-- could grant it to anyone, for up to 90 days, by calling the RPC directly
-- over PostgREST -- entirely outside the dashboard's own intended flow.
--
-- The client already *intends* this to be dual-controlled:
-- AdminDashboardScreen.tsx routes it through submitOrExecute(), which for a
-- non-super-admin submits a 'toggle_event_featured' request instead of
-- executing directly. But submitOrExecute is a client-side decision only --
-- the RPC itself admitted Sub-Admins, so the queue was advisory, not
-- enforcing.
--
-- THIS FIX HAS TWO REQUIRED HALVES:
--   (a) here: tighten the RPC to is_super_admin(), so a direct Sub-Admin
--       call fails no matter what client made it.
--   (b) 0092: add the missing 'toggle_event_featured' branch to
--       approve_admin_action's CASE, so a Sub-Admin's queued request can
--       actually be approved and executed.
-- Landing (a) without (b) -- which is exactly what a prior batch correctly
-- avoided by excluding this file -- would silently strand every Sub-Admin
-- submission: rejected at the RPC, and un-approvable in the queue.
--
-- WHY is_super_admin() IS COMPATIBLE WITH THE DUAL-CONTROL PATH.
-- approve_admin_action executes the mapped function via PERFORM, inside the
-- APPROVING admin's own session. SECURITY DEFINER changes the executing
-- Postgres role, not auth.uid() (a JWT claim) -- so when an Admin/Root
-- approves a Sub-Admin's queued request, is_super_admin() evaluates against
-- the approver and passes. This is exactly how the pre-existing
-- 'set_user_role' branch already works (admin_set_user_role has been
-- is_super_admin()-gated since the base schema).
--
-- Body below is reproduced from the LIVE production definition (pulled via
-- pg_get_functiondef immediately before writing this migration -- see the
-- Batch 1b pre-flight) with ONLY the gate and its error message changed.
-- Everything else -- duration bounds, both UPDATE branches, the admin_logs
-- write -- is untouched.
CREATE OR REPLACE FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer DEFAULT 14)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_end_date timestamptz;
BEGIN
  -- Was: is_admin(). Sub-Admins must now submit via request_admin_action
  -- ('toggle_event_featured') and have an Admin/Root approve it (see 0092).
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required to feature an event (your role: %). Sub-Admins must submit this for approval.',
      COALESCE(public.actor_role(), 'none');
  END IF;
  IF p_featured AND (p_duration_days IS NULL OR p_duration_days <= 0 OR p_duration_days > 90) THEN
    RAISE EXCEPTION 'Duration must be between 1 and 90 days';
  END IF;

  IF p_featured THEN
    v_end_date := now() + make_interval(days => p_duration_days);
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  ELSE
    UPDATE public.events SET is_featured = false, featured_until = NULL WHERE id = p_event_id;
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  SELECT auth.uid(), CASE WHEN p_featured THEN 'feature_event' ELSE 'unfeature_event' END,
         e.organizer_id, jsonb_build_object('event_id', p_event_id, 'featured', p_featured, 'duration_days', p_duration_days),
         public.actor_role()
  FROM public.events e WHERE e.id = p_event_id;
END;
$function$
;

-- Grants unchanged -- restated so this file is self-contained after
-- CREATE OR REPLACE. EXECUTE stays with authenticated because Sub-Admins
-- must still be able to *reach* the function (via the approval path, where
-- an Admin/Root's session executes it); the in-body is_super_admin() check
-- is what rejects a direct Sub-Admin call. Revoking EXECUTE instead would
-- also break the approve_admin_action path.
REVOKE ALL ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) TO authenticated, project_admin;
