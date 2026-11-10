-- Undo 0212: old app builds get "permission denied" again (the 0211 state).
-- Drops the update-required stub, gives the real function its old name back
-- and points request_withdrawal at it again. Grants end exactly as 0211 left
-- them: the old entry point closed to clients.
--
-- NOT touched: money, wallets, the ledger, withdrawal requests, approvals,
-- PINs. Run this BEFORE undo_0211 (undo_0211 refuses while 0212 is applied).
-- Refuses unless the operator confirms: SET vents.rollback_confirm = 'undo-0212';
DO $guard$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0212' THEN
    RAISE EXCEPTION 'undo_0212: set vents.rollback_confirm = ''undo-0212'' to confirm';
  END IF;
  IF to_regprocedure('public.request_organizer_payout_core(bigint,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'undo_0212: 0212 is not applied (request_organizer_payout_core is missing)';
  END IF;
  IF position('APP_UPDATE_REQUIRED' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.request_organizer_payout(bigint,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'undo_0212: request_organizer_payout is not the 0212 stub; stop and investigate';
  END IF;
END
$guard$;

DROP FUNCTION public.request_organizer_payout(bigint, uuid, text);
ALTER FUNCTION public.request_organizer_payout_core(bigint, uuid, text) RENAME TO request_organizer_payout;
REVOKE EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) FROM PUBLIC, anon, authenticated;

DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.request_withdrawal(bigint,uuid,text,text)'::regprocedure);
  v_old constant text := 'public.request_organizer_payout_core(p_amount_kobo, p_bank_account_id, v_key)';
BEGIN
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'undo_0212: request_withdrawal does not call the core exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, 'public.request_organizer_payout(p_amount_kobo, p_bank_account_id, v_key)');
END
$patch$;
