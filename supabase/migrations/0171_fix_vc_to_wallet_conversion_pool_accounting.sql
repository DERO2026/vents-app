-- Audit finding F21 (MASTER_AUDIT.md) -- forward fix only. NOT YET APPLIED
-- TO PRODUCTION -- drafted for review, pending explicit authorization.
-- The SEPARATE historical-backfill decision for the 7 conversions that
-- already ran before this fix existed is in
-- 0172_backfill_vc_to_wallet_pool_ledger_historical.sql -- deliberately
-- not combined into this file, since the forward fix and the historical
-- correction are different kinds of change with different risk profiles
-- and may be authorized independently.
--
-- convert_vc_to_wallet() debits the user's spendable VC (vents_wallets)
-- and credits real Naira into their cash wallet (user_wallets.balance_kobo)
-- -- a legitimate, permanent retirement of VC from circulation, exactly the
-- kind of event _vc_pool_move('credit', ...) exists to record (mirroring
-- admin_debit_vents_cents's own already-correct pattern: VC leaving a
-- user's balance for a reason other than ordinary spend-on-features credits
-- the pool back). The live function has never called it -- confirmed via
-- pg_get_functiondef and confirmed against 7 real production conversions
-- (362,000 VC / NGN36,200) with zero matching vc_pool_ledger rows.
--
-- This replacement is IDENTICAL to the live function except for one added
-- line (the _vc_pool_move call) placed immediately after the point the
-- live function already treats as "this is a genuinely new conversion, not
-- a replay" -- the v_rows = 0 early-return for an idempotent retry happens
-- BEFORE this point in both the live function and this replacement, so a
-- retried call with the same idempotency key still only ever reaches
-- _vc_pool_move once. No other behavior changes: same validation, same
-- tier gate, same rate (10 VC = N1), same minimum, same wallet mutations.
CREATE OR REPLACE FUNCTION public.convert_vc_to_wallet(p_vc_amount integer, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id    uuid := auth.uid();
  v_tier       text;
  v_tier_rank  integer;
  v_gold_rank  integer;
  v_balance    integer;
  v_naira      bigint;
  v_kobo       bigint;
  v_vc_tx_id   uuid;
  v_rows       integer;
  v_existing_amount integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  IF p_vc_amount IS NULL OR p_vc_amount <= 0 THEN
    RAISE EXCEPTION 'VC amount must be a positive integer';
  END IF;

  IF p_vc_amount < 10000 THEN
    RAISE EXCEPTION 'Minimum conversion is 10,000 VC';
  END IF;

  IF p_vc_amount % 10 <> 0 THEN
    RAISE EXCEPTION 'VC amount must be a multiple of 10 under the 10 VC = N1 rate';
  END IF;

  SELECT tier INTO v_tier FROM public.vc_tier_and_multiplier_for_user(v_user_id);
  SELECT rank INTO v_tier_rank FROM public.vc_badge_tiers WHERE tier = v_tier;
  SELECT rank INTO v_gold_rank FROM public.vc_badge_tiers WHERE tier = 'gold';
  IF v_tier_rank IS NULL OR v_tier_rank < v_gold_rank THEN
    RAISE EXCEPTION 'VC-to-wallet conversion requires Gold tier or higher';
  END IF;

  v_naira := (p_vc_amount::bigint / 10);
  v_kobo := v_naira * 100;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, reference_id, metadata)
  VALUES (v_user_id, p_vc_amount, 'spend', 'spent', now(), p_idempotency_key,
          jsonb_build_object('reason', 'vc_to_wallet_conversion', 'wallet_credit_kobo', v_kobo))
  ON CONFLICT (user_id, reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_vc_tx_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT amount INTO v_existing_amount FROM public.vc_transactions
     WHERE user_id = v_user_id AND reference_id = p_idempotency_key AND type = 'spend';
    RETURN jsonb_build_object(
      'converted', true, 'idempotent_replay', true,
      'vc_amount', v_existing_amount,
      'wallet_credit_kobo', (v_existing_amount::bigint / 10) * 100,
      'wallet_credit_naira', v_existing_amount / 10
    );
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance FROM public.vents_wallets WHERE user_id = v_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_vc_amount THEN
    RAISE EXCEPTION 'Insufficient Vents Cents balance';
  END IF;

  UPDATE public.vents_wallets SET balance = balance - p_vc_amount, updated_at = now() WHERE user_id = v_user_id;

  -- FIX (F21): credit the pool back now that this VC is genuinely and
  -- permanently leaving circulation. Reached at most once per unique
  -- idempotency key, since any replay already returned above.
  PERFORM public._vc_pool_move('credit', p_vc_amount, v_user_id, v_vc_tx_id, 'vc_to_wallet_conversion', v_user_id);

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
  VALUES (v_user_id, 'vc_conversion', v_kobo, 'Vents Cents converted to wallet balance', p_idempotency_key::text,
          jsonb_build_object('vc_amount', p_vc_amount, 'rate', '10_vc_per_naira', 'vc_transaction_id', v_vc_tx_id))
  ON CONFLICT (reference_id) WHERE (type = 'vc_conversion' AND reference_id IS NOT NULL) DO NOTHING;

  INSERT INTO public.user_wallets (user_id, balance_kobo)
  VALUES (v_user_id, v_kobo)
  ON CONFLICT (user_id) DO UPDATE
    SET balance_kobo = public.user_wallets.balance_kobo + v_kobo, updated_at = now();

  RETURN jsonb_build_object(
    'converted', true, 'idempotent_replay', false,
    'vc_amount', p_vc_amount,
    'wallet_credit_kobo', v_kobo,
    'wallet_credit_naira', v_naira,
    'vc_transaction_id', v_vc_tx_id
  );
END;
$function$;
