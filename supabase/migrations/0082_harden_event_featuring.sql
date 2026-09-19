-- P0-2 / P0-3 — Event featuring: move authorization into the RPC.
--
-- ROOT CAUSE. admin_set_event_featured (0004:1973) gated on is_admin(),
-- which is `is_root() OR role IN ('admin','sub-admin')` — i.e. it admitted
-- Sub-Admins. Featuring an event is not a moderation action; it grants
-- prime placement in the discovery feed, which the platform otherwise
-- sells. It is monetary-equivalent value, and a Sub-Admin could grant it to
-- anyone, for up to 90 days, by calling the RPC directly over PostgREST —
-- completely outside the React dashboard.
--
-- The client already *intended* this to be dual-controlled:
-- AdminDashboardScreen.tsx routes it through submitOrExecute(), which for a
-- non-super-admin submits a 'toggle_event_featured' request instead of
-- executing. But submitOrExecute is a client-side decision. The RPC itself
-- admitted Sub-Admins, so the queue was advisory, not enforcing — bypassing
-- the UI bypassed the control entirely.
--
-- THE FIX HAS TWO HALVES AND BOTH ARE REQUIRED.
--   (a) here: tighten the RPC to is_super_admin(), so a direct Sub-Admin
--       call fails no matter what client made it.
--   (b) 0086: add the missing 'toggle_event_featured' branch to
--       approve_admin_action's CASE, so the request a Sub-Admin submits can
--       actually be approved and executed.
-- Half (a) alone would silently break the Sub-Admin workflow — their
-- submissions would queue and then fail at approval (see 0086's header for
-- why that is today's actual behavior). Half (b) alone would leave the
-- direct-call hole wide open.
--
-- WHY is_super_admin() IS COMPATIBLE WITH THE DUAL-CONTROL PATH.
-- approve_admin_action executes the mapped function via PERFORM, inside the
-- approving admin's own session. SECURITY DEFINER changes the *executing
-- role*, not auth.uid() (a JWT claim). So when an Admin/Root approves a
-- Sub-Admin's queued request, is_super_admin() is evaluated against the
-- APPROVER and passes. This is exactly how the already-correct
-- 'set_user_role' branch works today — admin_set_user_role is
-- is_super_admin()-gated and is in the CASE list and functions normally.
--
-- Body below is byte-for-byte the 0004 original except for the single
-- changed gate and its error message. Duration bounds, both UPDATE
-- branches, and the admin_logs write are all preserved exactly.
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
  -- ('toggle_event_featured') and have an Admin/Root approve it.
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

-- Grants unchanged from 0011:111-112 — restated so this file is
-- self-contained after CREATE OR REPLACE. EXECUTE stays with authenticated
-- because Sub-Admins must still be able to *reach* the function; the
-- in-body is_super_admin() check is what rejects them. (Revoking EXECUTE
-- instead would also break the approve_admin_action path, which calls it
-- as the approving admin.)
REVOKE ALL ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) TO authenticated, project_admin;
