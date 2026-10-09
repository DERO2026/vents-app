-- Audit finding F21 (MASTER_AUDIT.md) -- SEPARATE historical reconciliation
-- plan, deliberately split from the forward fix in
-- 0171_fix_vc_to_wallet_conversion_pool_accounting.sql. NOT YET APPLIED TO
-- PRODUCTION -- drafted for review, NOT to be run without explicit
-- authorization, per this audit's constraint against unapproved changes to
-- live financial ledgers.
--
-- Scope: the 7 vc_to_wallet_conversion transactions that ran BEFORE the
-- forward fix existed (362,000 VC / NGN36,200 total, confirmed live) never
-- credited vc_pool_ledger/vc_system_pool. This corrects ONLY the pool's own
-- bookkeeping to reflect what already, legitimately happened to real user
-- balances -- it does NOT touch vents_wallets, user_wallets, or
-- user_wallet_transactions in any way. Those balances are already correct
-- (the users hold exactly the Naira they converted, confirmed live); only
-- the pool's ledger is out of sync with reality.
--
-- Follows this codebase's own established list-then-apply pattern
-- (0053_service_provider_capability_sync_invariant.sql's
-- list_service_provider_capability_desync/
-- backfill_service_provider_capability_desync): a read-only admin-only
-- "list" function to show exactly which rows are affected before anything
-- changes, and a separate, idempotent "apply" function scoped to exactly
-- those rows. Idempotent by construction: each run only processes
-- vc_transactions rows of reason 'vc_to_wallet_conversion' that have no
-- matching vc_pool_ledger row for that vc_transaction_id yet -- a second
-- run against an already-backfilled set finds nothing to do and returns 0.

-- Dry-run: exactly which historical conversions are missing a pool-ledger
-- credit. Run this first and review the output before calling the apply
-- function below.
CREATE OR REPLACE FUNCTION public.list_vc_to_wallet_pool_backfill_candidates()
 RETURNS TABLE(vc_transaction_id uuid, user_id uuid, vc_amount integer, wallet_credit_kobo bigint, converted_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT vt.id, vt.user_id, vt.amount, (vt.metadata->>'wallet_credit_kobo')::bigint, vt.created_at
  FROM public.vc_transactions vt
  WHERE vt.type = 'spend'
    AND vt.metadata->>'reason' = 'vc_to_wallet_conversion'
    AND NOT EXISTS (
      SELECT 1 FROM public.vc_pool_ledger pl WHERE pl.vc_transaction_id = vt.id
    )
  ORDER BY vt.created_at;
$function$;

REVOKE ALL ON FUNCTION public.list_vc_to_wallet_pool_backfill_candidates() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.list_vc_to_wallet_pool_backfill_candidates() TO authenticated, project_admin;

-- The actual repair: credits vc_system_pool/vc_pool_ledger for exactly the
-- rows the dry-run above lists -- never a broader sweep, never a row this
-- function didn't already identify as missing. Does NOT touch
-- vents_wallets/user_wallets/user_wallet_transactions (those are already
-- correct; only the pool's own ledger is being corrected). Logged to
-- admin_logs as one auditable batch action, same convention as every other
-- admin backfill in this codebase. Root-only (stricter than the
-- Super-Admin-gated pattern used elsewhere) given this directly moves the
-- authoritative 1,000,000,000 VC pool balance.
CREATE OR REPLACE FUNCTION public.backfill_vc_to_wallet_pool_ledger()
 RETURNS TABLE(vc_transaction_id uuid, user_id uuid, vc_amount integer, new_pool_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row record;
  v_new_balance numeric;
  v_count integer := 0;
  v_actor uuid := auth.uid();
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required for VC pool ledger backfill';
  END IF;

  FOR v_row IN
    SELECT vt.id, vt.user_id, vt.amount
    FROM public.vc_transactions vt
    WHERE vt.type = 'spend'
      AND vt.metadata->>'reason' = 'vc_to_wallet_conversion'
      AND NOT EXISTS (
        SELECT 1 FROM public.vc_pool_ledger pl WHERE pl.vc_transaction_id = vt.id
      )
    ORDER BY vt.created_at
  LOOP
    v_new_balance := public._vc_pool_move(
      'credit', v_row.amount, v_row.user_id, v_row.id,
      'backfill: vc_to_wallet_conversion (historical reconciliation, F21)', v_actor
    );
    v_count := v_count + 1;
    vc_transaction_id := v_row.id;
    user_id := v_row.user_id;
    vc_amount := v_row.amount;
    new_pool_balance := v_new_balance;
    RETURN NEXT;
  END LOOP;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_actor, 'vc_pool_ledger_historical_backfill', NULL,
    jsonb_build_object('count', v_count, 'reason', 'F21: convert_vc_to_wallet never credited the pool before the forward fix'),
    public.actor_role()
  );

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_vc_to_wallet_pool_ledger() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.backfill_vc_to_wallet_pool_ledger() TO authenticated, project_admin;
