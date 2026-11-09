-- Undo 0207 only (supabase/migrations/0207_withdrawal_bank_reassignment.sql).
-- NOT a migration; never applied by tooling. Use only as runbook row R1c,
-- in one transaction:
--   SET vents.rollback_confirm = 'undo-0207';
--   \i supabase/rollback/undo_0207.sql
-- Refused once any reassignment has been executed (dropping the record
-- would erase the audit trail of where a withdrawal was sent) or while a
-- reassignment request is pending. It changes no withdrawal, wallet or
-- ledger row.
DO $undo$
DECLARE
  v_def text;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0207' THEN
    RAISE EXCEPTION 'undo_0207 refused: set vents.rollback_confirm = ''undo-0207'' to confirm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.withdrawal_bank_reassignments) THEN
    RAISE EXCEPTION 'undo_0207 refused: withdrawals have been reassigned; their audit record cannot be dropped';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_action_requests WHERE action_type = 'reassign_withdrawal_bank_account' AND status = 'pending') THEN
    RAISE EXCEPTION 'undo_0207 refused: reject the pending reassign_withdrawal_bank_account requests first';
  END IF;

  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  IF position('execute_withdrawal_bank_reassignment' IN v_def) > 0 THEN
    EXECUTE replace(v_def,
      E'      ELSIF r.action_type = ''reassign_withdrawal_bank_account'' THEN\n        PERFORM public.execute_withdrawal_bank_reassignment(r.id);\n', '');
  END IF;
  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position(E', ''reassign_withdrawal_bank_account''' IN v_def) > 0 THEN
    EXECUTE replace(v_def, E', ''reassign_withdrawal_bank_account''', '');
  END IF;
END
$undo$;

DROP FUNCTION IF EXISTS public.admin_request_withdrawal_bank_reassignment(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.execute_withdrawal_bank_reassignment(uuid);
DROP FUNCTION IF EXISTS public.withdrawal_reassignment_validate(uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.mask_account_number(text);
DROP TRIGGER IF EXISTS organizer_withdrawal_destination_guard ON public.organizer_withdrawal_requests;
DROP FUNCTION IF EXISTS public.organizer_withdrawal_destination_guard();
DROP TABLE IF EXISTS public.withdrawal_bank_reassignments;
DROP FUNCTION IF EXISTS public.withdrawal_bank_reassignments_append_only();
