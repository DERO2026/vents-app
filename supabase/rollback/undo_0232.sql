-- Undo 0232 (staff guard in set_signup_role, finding N2). Gated: run with
--   SET vents.rollback_confirm = 'undo-0232';
-- Reverses the in-place patch exactly (refuses if the function no longer
-- carries it). No data is touched. WARNING: after undo a sub-admin (or root,
-- if its role is not 'admin') can again give themselves organizer tools by
-- calling set_signup_role('organizer') directly.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0232' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0232'' first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.vents_undo_0232(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'undo_0232: % does not carry 0232 patch % exactly once; refusing', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_undo_0232('public.set_signup_role(text)', ARRAY[
  ARRAY[$a$  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  -- [0232] Staff (root, admin, sub-admin) never gain organizer tools through
  -- ordinary-user role selection; a Super Admin grants that separately.
  IF p_role = 'organizer' AND (public.is_admin() OR v_current_role IN ('admin', 'sub-admin')) THEN
    RAISE EXCEPTION 'Staff accounts cannot turn on organizer tools here. A Super Admin can grant organizer access.';
  END IF;$a$, $a$  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;$a$]
]);

COMMIT;
