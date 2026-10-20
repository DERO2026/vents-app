-- Audit finding F21 (MASTER_AUDIT.md) -- duplicate-credit (TOCTOU) protection
-- for the VC pool ledger backfill, authorized and APPLIED TO PRODUCTION as
-- Step 1 of the explicitly-authorized VC pool accounting repair sequence
-- (see 0171_fix_vc_to_wallet_conversion_pool_accounting.sql and
-- 0172_backfill_vc_to_wallet_pool_ledger_historical.sql for the forward fix
-- and historical backfill applied immediately after it). This file was
-- committed after the fact to close the gap where the index existed live
-- but had no corresponding migration file in the repository.
--
-- Without this, the NOT EXISTS check used by both
-- list_vc_to_wallet_pool_backfill_candidates() and
-- backfill_vc_to_wallet_pool_ledger() to find vc_transactions rows missing a
-- pool-ledger credit is subject to a TOCTOU race: two concurrent calls could
-- both pass the check for the same vc_transaction_id before either commits,
-- double-crediting the pool. Partial (not plain unique) because one
-- legitimate live row -- the initial system-pool reconciliation entry from
-- migration 0147 -- has vc_transaction_id IS NULL by design and must remain
-- unaffected; confirmed live before this was applied that no duplicate
-- non-null vc_transaction_id values existed yet, so this index could be
-- added without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS vc_pool_ledger_vc_transaction_id_uniq
  ON public.vc_pool_ledger (vc_transaction_id)
  WHERE vc_transaction_id IS NOT NULL;
