-- 0232: staff accounts cannot gain organizer tools through ordinary-user role
-- selection (finding N2, docs/repair-tracker.md).
--
-- D1a (owner, 2026-11-26): an ordinary user becomes an Organizer by choosing
-- it -- set_signup_role('organizer'), at sign-up or from "Become an
-- Organizer" -- with no admin approval. set_signup_role (0121) refused only
-- role = 'admin'. A sub-admin, or the root account if its role is not
-- 'admin', could call it directly over the API and give themselves
-- is_organizer = true; only the app hid the option.
--
-- Fix: set_signup_role('organizer') refuses every staff account -- root
-- (is_root), role 'admin' and role 'sub-admin' -- on the server. Ordinary
-- users are unaffected (D1a). set_signup_role('user') is unchanged (it never
-- grants anything). Staff organizer status still comes only from the
-- existing Super Admin paths (admin_set_organizer_capability, organizer
-- request decisions, dual-control actions); existing is_organizer values are
-- not touched. Other paths were reviewed and already refuse staff:
-- promote_to_organizer (revoked from clients by 0116, refuses staff) and a
-- direct UPDATE of users.is_organizer (trg_protect_capability_columns).
--
-- Patched IN PLACE from the live definition (one anchor, must match exactly
-- once, else the migration refuses). Grants unchanged.
-- Undo: supabase/rollback/undo_0232.sql.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.set_signup_role(text)') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION '0232: set_signup_role or is_admin is missing; refusing';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION pg_temp.vents_0232_patch(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  IF position('[0232]' IN v_def) > 0 THEN
    RAISE EXCEPTION '0232: % is already patched; refusing to run twice', p_sig;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION '0232: % is not the expected version (anchor % not found exactly once); refusing to patch', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_0232_patch('public.set_signup_role(text)', ARRAY[
  ARRAY[$a$  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;$a$, $a$  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  -- [0232] Staff (root, admin, sub-admin) never gain organizer tools through
  -- ordinary-user role selection; a Super Admin grants that separately.
  IF p_role = 'organizer' AND (public.is_admin() OR v_current_role IN ('admin', 'sub-admin')) THEN
    RAISE EXCEPTION 'Staff accounts cannot turn on organizer tools here. A Super Admin can grant organizer access.';
  END IF;$a$]
]);

COMMIT;
