-- 0228: close H2 / L4 fully -- the old open lookups become server-only.
--
-- resolve_username_to_email(username) returns any account's email, and
-- get_account_status(email) any account's status, to anyone. 0227 added the
-- password-gated replacements the current app uses (resolve_login_email,
-- get_login_account_status). This revokes the old ones from client roles;
-- server code (project_admin) keeps them.
--
-- APPLY ONLY WHEN:
--   1. the web app with 0227's client change is deployed (else username
--      login on the web breaks), and
--   2. you accept that installed native builds older than that change lose
--      USERNAME login (they show "We couldn't verify your login right now";
--      EMAIL login keeps working), or those builds have been forced to update.
-- Prerequisite: 0227. Undo: supabase/rollback/undo_0228.sql.
BEGIN;
DO $pre$
BEGIN
  IF to_regprocedure('public.resolve_login_email(text,text)') IS NULL
     OR to_regprocedure('public.get_login_account_status(text,text)') IS NULL THEN
    RAISE EXCEPTION '0228: 0227 is not applied (its replacements are missing); refusing';
  END IF;
END
$pre$;
REVOKE EXECUTE ON FUNCTION public.resolve_username_to_email(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_account_status(text) FROM PUBLIC, anon, authenticated;
COMMIT;
