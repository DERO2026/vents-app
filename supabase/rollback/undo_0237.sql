-- Undo 0237. Gated: run with SET vents.rollback_confirm = 'undo-0237';
-- Restores 0008's organizer_reviews insert/update policies verbatim and drops
-- the helper. Existing reviews are not touched.
-- WARNING: any signed-in user can again review any organizer directly.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0237' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0237'' first';
  END IF;
  IF to_regprocedure('public.user_attended_organizer_event(uuid)') IS NULL THEN
    RAISE EXCEPTION 'undo_0237: 0237 is not applied';
  END IF;
END $$;
DROP POLICY organizer_reviews_insert ON public.organizer_reviews;
CREATE POLICY organizer_reviews_insert ON organizer_reviews FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = reviewer_id));
DROP POLICY organizer_reviews_update ON public.organizer_reviews;
CREATE POLICY organizer_reviews_update ON organizer_reviews FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = reviewer_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = reviewer_id));
DROP FUNCTION public.user_attended_organizer_event(uuid);
COMMIT;
