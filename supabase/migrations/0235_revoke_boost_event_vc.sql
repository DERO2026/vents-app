-- 0235: least privilege for boost_event_vc (AZ-32 / L3).
--
-- 0011_grants.sql granted EXECUTE on boost_event_vc to anon and
-- authenticated. Nothing in the app, the API routes or any database
-- function calls it, and nothing reads the vc_event_boosts rows it writes:
-- a signed-in organizer calling it directly is charged 1,000 VENTS Cents
-- (_vc_deduct) for a "boost" with no effect anywhere. Anonymous callers were
-- already refused inside the function (no auth.uid()), but the grant itself
-- was wider than needed.
--
-- Fix: revoke EXECUTE from PUBLIC, anon and authenticated. project_admin
-- (server-side) keeps it, so a future, deliberate server workflow can still
-- use it. The function body is unchanged; no data changes.
-- Rollback: supabase/rollback/undo_0235.sql (restores 0011's grants).

BEGIN;
DO $pre$
BEGIN
  IF to_regprocedure('public.boost_event_vc(uuid)') IS NULL THEN
    RAISE EXCEPTION '0235: public.boost_event_vc(uuid) not found';
  END IF;
END
$pre$;
REVOKE ALL ON FUNCTION public.boost_event_vc(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boost_event_vc(uuid) TO project_admin;
COMMIT;
