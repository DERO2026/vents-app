-- Batch E: VC -> VENTS Wallet conversion.
--
-- Approved economics: 10 VC = N1, minimum 10,000 VC (N1,000), Gold tier or
-- higher only, credits the existing customer VENTS Wallet (user_wallets /
-- user_wallet_transactions) -- never a direct bank payout. The existing
-- wallet withdrawal flow (separate, unchanged by this batch) is how a user
-- later moves that NGN to their bank.
--
-- Already applied live to production (project slrtjxtzhowhwhebjprv) via
-- the Supabase MCP apply_migration tool, across two live migrations
-- (`vc_wallet_conversion_foundation` and
-- `vc_wallet_conversion_fix_conflict_predicates`, the second fixing an
-- ON CONFLICT predicate that didn't exactly match the new partial unique
-- indexes' WHERE clauses on first attempt) -- this single file reproduces
-- the final, corrected, live state.
--
-- 1. New wallet transaction type. Audited every existing type first:
--    'deposit' means a Paystack-verified external payment landed in the
--    wallet (confirm_wallet_deposit); 'spend' means wallet NGN was spent
--    on a purchase; 'refund' means a prior wallet spend was reversed. None
--    of these correctly describe "VC was converted into wallet NGN" --
--    conflating it with 'deposit' would make VC conversions
--    indistinguishable from real Paystack payments in financial reporting
--    and reconciliation. A new type is genuinely required.
ALTER TABLE public.user_wallet_transactions DROP CONSTRAINT user_wallet_transactions_type_check;
ALTER TABLE public.user_wallet_transactions
  ADD CONSTRAINT user_wallet_transactions_type_check
  CHECK (type = ANY (ARRAY['deposit'::text, 'spend'::text, 'refund'::text, 'vc_conversion'::text]));

-- Same idempotency-dedup convention already used for every other wallet
-- transaction type on this table (deposit/spend/refund each have their
-- own partial unique index on reference_id).
CREATE UNIQUE INDEX user_wallet_transactions_vc_conversion_ref_idx
  ON public.user_wallet_transactions (reference_id)
  WHERE (type = 'vc_conversion' AND reference_id IS NOT NULL);

-- 2. Matching dedup capability on the VC ledger side. vc_transactions
--    already has a unique partial index for type='earn' (keyed on
--    campaign_key + reference_id) and type='referral' (keyed on
--    reference_id alone), but NONE for type='spend' -- _vc_deduct() (the
--    only existing spend-side helper) generates its own random
--    reference_id with no caller-supplied idempotency key at all, so it
--    cannot be reused as-is for a client-retryable operation. This index
--    is additive and does not change the meaning or behavior of any
--    existing spend row (confirmed zero duplicate (user_id, reference_id)
--    pairs in production before adding it).
CREATE UNIQUE INDEX vc_transactions_spend_dedup_idx
  ON public.vc_transactions (user_id, reference_id)
  WHERE (type = 'spend' AND reference_id IS NOT NULL);

-- 3. The conversion function itself. One atomic SECURITY DEFINER call:
--    either both the VC debit and the wallet credit happen, or neither
--    does (a single plpgsql function body is one transaction from the
--    caller's perspective -- any RAISE rolls back everything it did).
--
--    Idempotency: p_idempotency_key must be a client-generated UUID, used
--    verbatim as both ledger rows' reference_id. The VC-side insert is
--    attempted first with ON CONFLICT (user_id, reference_id) DO NOTHING;
--    if it conflicts, this exact key was already fully processed (since
--    the wallet credit can only ever exist in the same transaction as the
--    VC debit that produced it) -- the original amount is read back and
--    returned unchanged, with no further balance check and no second
--    wallet credit, even if the retry supplies a different amount under
--    the same key. This is the same proven idiom already used by
--    confirm_wallet_deposit and the Batch A/B/C earn-campaign dedup
--    indexes, not a new mechanism.
--
--    Concurrency: the wallet/VC balance (vents_wallets.balance) is only
--    locked (SELECT ... FOR UPDATE) AFTER the idempotency-key insert
--    succeeds, so pure retries with the same key never contend for the
--    lock at all. Two different concurrent conversion requests for the
--    same user (different keys) still serialize correctly on that lock:
--    whichever acquires it first decrements the balance; the second sees
--    the now-lower balance and is rejected with insufficient_balance if
--    it would go negative, which also rolls back its own VC-ledger insert
--    (no phantom VC debit ever persists without a matching wallet credit).
--
--    Tier authorization is read fresh from vc_tier_and_multiplier_for_user
--    (vc_lifetime_earned), never from users.vc_badge, current VC balance,
--    or any client-supplied value -- Batch A/D's authoritative tier
--    system, unchanged here. vc_lifetime_earned is never touched: this
--    writes a vc_transactions row of type='spend', and lifetime-earned is
--    only ever incremented by award_vc_reward() (Batch A), never
--    decremented by anything -- spending/converting VC structurally
--    cannot lower lifetime-earned, tier, or multiplier.
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

  -- Integer-safe: p_vc_amount is already confirmed divisible by 10 above.
  v_naira := (p_vc_amount::bigint / 10);
  v_kobo := v_naira * 100;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, reference_id, metadata)
  VALUES (v_user_id, p_vc_amount, 'spend', 'spent', now(), p_idempotency_key,
          jsonb_build_object('reason', 'vc_to_wallet_conversion', 'wallet_credit_kobo', v_kobo))
  ON CONFLICT (user_id, reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_vc_tx_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Idempotent replay: this key was already fully processed (VC debit
    -- and wallet credit happen in the same transaction, so if the VC row
    -- exists the wallet row does too). Return the ORIGINAL amount, not
    -- whatever p_vc_amount was passed on this retry.
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

REVOKE ALL ON FUNCTION public.convert_vc_to_wallet(integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_vc_to_wallet(integer, uuid) TO authenticated, project_admin;

-- 4. Retire the old direct VC-to-bank cash-out path. Audited: zero
--    frontend call sites anywhere in the codebase, zero rows ever in
--    vc_withdrawal_requests, zero rows ever in vc_bank_accounts -- this
--    was built but never actually launched to users. It is still
--    EXECUTE-granted to `authenticated` and has no tier gate at all (any
--    Bronze-tier user could call it) and a far lower 1,000 VC minimum --
--    a direct conflict with the new Gold+/10,000 VC/wallet-only model,
--    since it would let any user bypass both restrictions and go straight
--    to a bank transfer. Retired the same way purchase_badge() was in
--    Batch D: kept defined for compatibility, now raises a clear
--    exception instead of processing anything. No VC deduction, no
--    vc_withdrawal_requests row, ever again.
CREATE OR REPLACE FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RAISE EXCEPTION 'Direct VC cash-out has been retired. Convert Vents Cents to your VENTS Wallet balance (Gold tier or higher, 10,000 VC minimum), then withdraw from your wallet as usual.';
END;
$function$;
