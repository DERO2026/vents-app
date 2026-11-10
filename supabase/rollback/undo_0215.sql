-- Undo 0215 (VENTS-to-VENTS wallet transfers).
--
-- Always: removes every transfer function, so no new transfer can happen.
-- Only when NO transfer was ever made: also removes the wallet_transfers
-- table, the two ledger types and their indexes, and the kill-switch column,
-- returning the schema to exactly its pre-0215 state.
-- When transfers exist: they are financial history (both parties' ledger
-- rows and balances already reflect them), so the table, its rows, the
-- ledger types and the column are KEPT. Nothing is reversed and no balance
-- changes. The kill switch is set to off.
--
-- No balance, ledger row or other financial record is touched either way.
-- Refuses unless the operator confirms: SET vents.rollback_confirm = 'undo-0215';
DO $guard$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0215' THEN
    RAISE EXCEPTION 'undo_0215: set vents.rollback_confirm = ''undo-0215'' to confirm';
  END IF;
  IF to_regprocedure('public.transfer_wallet_funds(uuid,bigint,text,text,text)') IS NULL
     AND to_regclass('public.wallet_transfers') IS NULL THEN
    RAISE EXCEPTION 'undo_0215: 0215 is not applied';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.transfer_wallet_funds(uuid, bigint, text, text, text);
DROP FUNCTION IF EXISTS public.find_wallet_transfer_recipient(text);
DROP FUNCTION IF EXISTS public.get_my_wallet_transfer_status();
DROP FUNCTION IF EXISTS public.get_my_wallet_transfer(text);
DROP FUNCTION IF EXISTS public.admin_set_wallet_transfers_enabled(boolean);
DROP FUNCTION IF EXISTS public.wallet_transfer_policy();
DROP FUNCTION IF EXISTS public.wallet_transfer_account_ok(uuid);
DROP FUNCTION IF EXISTS public.wallet_display_name(uuid);

DO $schema$
DECLARE
  v_used boolean;
BEGIN
  v_used := (to_regclass('public.wallet_transfers') IS NOT NULL AND EXISTS (SELECT 1 FROM public.wallet_transfers))
         OR EXISTS (SELECT 1 FROM public.user_wallet_transactions WHERE type IN ('transfer_out', 'transfer_in'));
  IF v_used THEN
    UPDATE public.app_config SET disable_wallet_transfers = true;
    RAISE NOTICE 'undo_0215: transfers exist; their records, ledger types and the kill switch were kept (switch set to off)';
    RETURN;
  END IF;
  DROP TABLE IF EXISTS public.wallet_transfers;
  DROP FUNCTION IF EXISTS public.wallet_transfers_immutable();
  DROP FUNCTION IF EXISTS public.wallet_transfers_disabled();
  DROP INDEX IF EXISTS public.user_wallet_transactions_transfer_out_ref_idx;
  DROP INDEX IF EXISTS public.user_wallet_transactions_transfer_in_ref_idx;
  ALTER TABLE public.user_wallet_transactions DROP CONSTRAINT IF EXISTS user_wallet_transactions_type_check;
  ALTER TABLE public.user_wallet_transactions ADD CONSTRAINT user_wallet_transactions_type_check
    CHECK (type = ANY (ARRAY['deposit'::text, 'spend'::text, 'refund'::text, 'vc_conversion'::text]));
  ALTER TABLE public.app_config DROP COLUMN IF EXISTS disable_wallet_transfers;
END
$schema$;
