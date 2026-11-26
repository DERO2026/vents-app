-- Undo 0228. Gated: run with SET vents.rollback_confirm = 'undo-0228';
-- Re-grants the old open lookups exactly as 0011 did. WARNING: this
-- re-opens H2 (anyone can read any user's email by username) and L4.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0228' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0228'' first';
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.resolve_username_to_email(p_username text) TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_account_status(p_email text) TO anon, authenticated, project_admin;
COMMIT;
