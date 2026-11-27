-- Undo 0236. Gated: run with SET vents.rollback_confirm = 'undo-0236';
-- Restores 0008's select_events policy verbatim and drops the helper.
-- WARNING: drafts and admin-hidden events become readable by anyone again.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0236' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0236'' first';
  END IF;
  IF to_regprocedure('public.user_holds_ticket_for_event(uuid)') IS NULL THEN
    RAISE EXCEPTION 'undo_0236: 0236 is not applied';
  END IF;
END $$;
DROP POLICY select_events ON public.events;
CREATE POLICY select_events ON public.events FOR SELECT TO public USING (((deleted_at IS NULL) OR (organizer_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
DROP FUNCTION public.user_holds_ticket_for_event(uuid);
COMMIT;
