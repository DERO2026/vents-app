-- 0236: draft and admin-hidden events are not readable by the public
-- (AZ-16 / OEL-06 / M3).
--
-- Problem: the only SELECT policy on public.events (0008) is
--   deleted_at IS NULL OR organizer_id = auth.uid() OR is_admin()
-- so ANY caller, signed in or not, could read every draft and every event an
-- admin had hidden, straight from the REST API (and receive them over
-- Realtime, and through saved events and shared links, which all read this
-- table under this policy).
--
-- New rule (same policy name, replaced):
--   * the organizer and admins (is_admin: root, admin, sub-admin) see their
--     events exactly as before, drafts and hidden ones included;
--   * everyone else sees an event only if it is not deleted, not a draft
--     and not hidden by an admin (live, coming_soon, ended or cancelled
--     events stay public as before);
--   * a buyer who holds a ticket for an event can still open it when it is
--     later hidden or moved back to draft (My Tickets, refunds), but never a
--     deleted one (unchanged).
-- The ticket check runs in a SECURITY DEFINER helper: anonymous visitors
-- have no access to tickets, and a policy subquery runs with the caller's
-- privileges.
--
-- Already safe and unchanged: search_events_fuzzy (filters hidden, deleted
-- and non-live itself) and every other read path that goes through this
-- table. No data changes.
-- Rollback: supabase/rollback/undo_0236.sql (restores 0008's policy).

BEGIN;

DO $pre$
DECLARE
  v_qual text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_qual
    FROM pg_policy p WHERE p.polrelid = 'public.events'::regclass AND p.polname = 'select_events';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION '0236: policy select_events on public.events not found';
  END IF;
  IF position('user_holds_ticket_for_event' IN v_qual) > 0 THEN
    RAISE EXCEPTION '0236 already applied; refusing to run twice';
  END IF;
  IF regexp_replace(v_qual, '\s+', '', 'g') IS DISTINCT FROM
     '((deleted_atISNULL)OR(organizer_id=(SELECTauth.uid()ASuid))ORis_admin())' THEN
    RAISE EXCEPTION '0236 refused: select_events is not the 0008 policy (live: %)', v_qual;
  END IF;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.events'::regclass AND p.polcmd IN ('r', '*')) <> 1 THEN
    RAISE EXCEPTION '0236 refused: public.events has other SELECT policies; review them first';
  END IF;
END
$pre$;

CREATE FUNCTION public.user_holds_ticket_for_event(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tickets t WHERE t.event_id = p_event_id AND t.user_id = auth.uid());
$function$;
REVOKE ALL ON FUNCTION public.user_holds_ticket_for_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_holds_ticket_for_event(uuid) TO anon, authenticated, project_admin;

DROP POLICY select_events ON public.events;
CREATE POLICY select_events ON public.events FOR SELECT TO public USING (
  (organizer_id = (SELECT auth.uid() AS uid))
  OR public.is_admin()
  OR (deleted_at IS NULL AND status <> 'draft' AND NOT hidden_by_admin)
  OR (deleted_at IS NULL AND public.user_holds_ticket_for_event(id))
);

COMMIT;
