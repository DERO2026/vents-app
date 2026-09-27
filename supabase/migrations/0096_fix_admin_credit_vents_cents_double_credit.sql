-- Fix confirmed production bug (discovered while testing 0095, separate
-- from self-approval -- shipped as its own migration per explicit
-- instruction): admin_credit_vents_cents double-credits on every call.
--
-- Root cause: it both
--   (a) INSERTs into vc_transactions with type='earn', status='active',
--       which fires the existing AFTER INSERT trigger trg_vc_wallet_sync
--       (trg_sync_vc_to_wallet()), which itself upserts vents_wallets
--       (balance += NEW.amount); AND
--   (b) separately, explicitly does its own
--       INSERT ... ON CONFLICT (user_id) DO UPDATE SET balance = balance
--       + p_amount::integer on vents_wallets.
-- Both paths run in the same statement/transaction, so the wallet receives
-- the amount twice: a requested 5,000 VC credit produces a 10,000 balance
-- increase.
--
-- Confirmed this is the ONLY earn/referral-crediting path with this bug.
-- Every other function that inserts vc_transactions with
-- type IN ('earn','referral') AND status='active' relies exclusively on
-- trg_vc_wallet_sync and does NOT also touch vents_wallets directly:
--   - confirm_ticket_payment (0004_functions.sql)
--   - confirm_ticket_payment_via_wallet (0075_*.sql)
--   - claim_profile_bonus
--   - complete_referral (referred-user leg; the referrer's 'pending' leg
--     is activated later via UPDATE in check_and_clear_pending_vc, which
--     is a separate, pre-existing design this fix does not touch)
-- admin_debit_vents_cents (via _vc_deduct) is a different, correct design:
-- it inserts vc_transactions with status='spent' (which
-- trg_vc_wallet_sync's ELSIF only matches for status='active', so the
-- trigger never fires for it) and does its own explicit balance
-- subtraction as the sole, authoritative debit path. This fix does not
-- touch admin_debit_vents_cents or _vc_deduct at all.
--
-- Fix: remove admin_credit_vents_cents's redundant explicit vents_wallets
-- upsert, making it consistent with every other earn/referral credit path
-- -- the trg_vc_wallet_sync trigger becomes the single authoritative
-- writer of vents_wallets.balance for every credit, exactly as it already
-- is for confirm_ticket_payment/confirm_ticket_payment_via_wallet/
-- claim_profile_bonus/complete_referral. One INSERT into vc_transactions,
-- one trigger-driven balance update, no double-application.
--
-- Nothing else changes: self-approval/self-target guards from 0095 are
-- preserved verbatim, admin_debit_vents_cents/approve_admin_action are
-- untouched, and this migration does not alter any existing balance or
-- transaction row -- only future admin_credit_vents_cents calls are
-- affected.

CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot credit your own Vents Cents balance';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  -- The single authoritative write: trg_vc_wallet_sync (AFTER INSERT ON
  -- vc_transactions) applies this to vents_wallets.balance exactly once.
  -- Do NOT also upsert vents_wallets here -- that was the double-credit bug.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_credit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN 'ok';
END;
$function$;
