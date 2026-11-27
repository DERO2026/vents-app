-- 0237: only people who attended can review an organizer (AZ-33 / L12).
--
-- Context: the app's only review flow is service-provider reviews, which
-- already require a completed booking (0099). There is no event-review
-- screen. The organizer_reviews table (0002, publicly readable) is not used
-- by the app, but its RLS let ANY signed-in user write a 1-5 star review of
-- ANY organizer straight through the REST API (organizer_reviews_insert
-- checked only reviewer_id = auth.uid()), and edit it the same way.
--
-- New rule for INSERT and UPDATE (the delete and read policies are
-- unchanged; UNIQUE (organizer_id, reviewer_id) already allows one review per
-- organizer per person):
--   * the reviewer is the caller;
--   * an organizer can't review themselves;
--   * the caller holds a ticket for one of that organizer's events that is
--     active (not cancelled), paid (not pending, failed, refund_pending or
--     refunded) and checked in at the door: attendance evidence, not just a
--     purchase. Free tickets are issued 'paid' (0220), so free events count.
-- Admins have no write bypass (they moderate by other means).
-- The check runs in a SECURITY DEFINER helper because a policy subquery
-- runs with the caller's privileges.
-- Rollback: supabase/rollback/undo_0237.sql (restores 0008's policies).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.organizer_reviews') IS NULL THEN
    RAISE EXCEPTION '0237: public.organizer_reviews not found';
  END IF;
  IF to_regprocedure('public.user_attended_organizer_event(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '0237 already applied; refusing to run twice';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organizer_reviews'::regclass AND polname = 'organizer_reviews_insert')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organizer_reviews'::regclass AND polname = 'organizer_reviews_update') THEN
    RAISE EXCEPTION '0237 refused: the 0008 insert/update policies on organizer_reviews are missing';
  END IF;
END
$pre$;

CREATE FUNCTION public.user_attended_organizer_event(p_organizer_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
     WHERE e.organizer_id = p_organizer_id
       AND t.user_id = auth.uid()
       AND t.status = 'active'
       AND t.payment_status = 'paid'
       AND t.checked_in);
$function$;
REVOKE ALL ON FUNCTION public.user_attended_organizer_event(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_attended_organizer_event(uuid) TO authenticated, project_admin;

DROP POLICY organizer_reviews_insert ON public.organizer_reviews;
CREATE POLICY organizer_reviews_insert ON public.organizer_reviews FOR INSERT TO authenticated WITH CHECK (
  reviewer_id = (SELECT auth.uid() AS uid)
  AND reviewer_id <> organizer_id
  AND public.user_attended_organizer_event(organizer_id)
);
DROP POLICY organizer_reviews_update ON public.organizer_reviews;
CREATE POLICY organizer_reviews_update ON public.organizer_reviews FOR UPDATE TO authenticated
  USING (reviewer_id = (SELECT auth.uid() AS uid))
  WITH CHECK (
    reviewer_id = (SELECT auth.uid() AS uid)
    AND reviewer_id <> organizer_id
    AND public.user_attended_organizer_event(organizer_id)
  );

COMMIT;
