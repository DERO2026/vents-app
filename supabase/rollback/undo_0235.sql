-- Undo 0235. Gated: run with SET vents.rollback_confirm = 'undo-0235';
-- Restores 0011_grants.sql's grants on boost_event_vc exactly.
-- WARNING: signed-in users can again spend 1,000 VENTS Cents on a boost that
-- has no effect by calling the function directly.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0235' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0235'' first';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.boost_event_vc(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.boost_event_vc(p_event_id uuid) TO anon, authenticated, project_admin;
COMMIT;
