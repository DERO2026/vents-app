-- Undo 0205 only (supabase/migrations/0205_payout_cancelled_transfer_safety.sql).
-- NOT a migration; never applied by tooling. Use only as runbook row R1a,
-- in one transaction:
--   SET vents.rollback_confirm = 'undo-0205';
--   \i supabase/rollback/undo_0205.sql
-- It restores 0202's organizer_withdrawal_transfer_guard (body copied
-- verbatim from 0202), so the table is never left without a transfer
-- guard. It changes no balance, ledger row or request. Undo order is the
-- reverse of apply order: R1c (0207) -> R1b (0206) -> R1a (0205).
DO $undo_guard$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0205' THEN
    RAISE EXCEPTION 'undo_0205 refused: set vents.rollback_confirm = ''undo-0205'' to confirm';
  END IF;
  -- 0206 calls payout_cancel_returned_funds() (dropped below). Undo in
  -- reverse order: R1c (0207), R1b (0206), then R1a (0205).
  IF to_regprocedure('public.execute_earnings_adjustment(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'undo_0205 refused: 0206 is still installed and depends on 0205; undo 0206 first (runbook R1b), or keep 0205';
  END IF;
END
$undo_guard$;

DROP TRIGGER IF EXISTS organizer_withdrawal_requests_guard ON public.organizer_withdrawal_requests;
DROP TRIGGER IF EXISTS organizer_withdrawal_requests_no_delete ON public.organizer_withdrawal_requests;
DROP FUNCTION IF EXISTS public.organizer_withdrawal_requests_guard();
DROP FUNCTION IF EXISTS public.organizer_withdrawal_requests_no_delete();
DROP FUNCTION IF EXISTS public.admin_payout_integrity_report();
DROP FUNCTION IF EXISTS public.payout_cancel_returned_funds(uuid);

CREATE OR REPLACE FUNCTION public.organizer_withdrawal_transfer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.transfer_code IS NOT NULL AND NEW.transfer_code IS DISTINCT FROM OLD.transfer_code THEN
    RAISE EXCEPTION 'Withdrawal %: its Paystack transfer code cannot be changed or cleared', OLD.id;
  END IF;
  IF OLD.paystack_reference IS NOT NULL AND NEW.paystack_reference IS DISTINCT FROM OLD.paystack_reference THEN
    RAISE EXCEPTION 'Withdrawal %: its Paystack reference cannot be changed or cleared', OLD.id;
  END IF;
  IF OLD.transfer_code IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('cancelled', 'rejected', 'pending') THEN
    RAISE EXCEPTION 'Withdrawal %: a Paystack transfer exists (%), so it cannot be set to %; only Paystack''s outcome (completed, failed, reversed) can end it',
      OLD.id, OLD.transfer_code, NEW.status;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS organizer_withdrawal_transfer_guard ON public.organizer_withdrawal_requests;
CREATE TRIGGER organizer_withdrawal_transfer_guard
  BEFORE UPDATE ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.organizer_withdrawal_transfer_guard();
REVOKE ALL ON FUNCTION public.organizer_withdrawal_transfer_guard() FROM PUBLIC, anon, authenticated;
