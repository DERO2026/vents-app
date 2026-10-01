-- VENTS Cents economy reconciliation (Prompt 1):
--
-- 1. VENTS Cents is an internal VENTS-controlled currency, not Paystack money.
--    Every VC credit must be accounted for against a single admin/system pool
--    (authoritative supply: 1,000,000,000 VC), never materialized from nothing.
-- 2. Admin credits/debits must be idempotent, auditable, and must NOT
--    automatically count toward users.vc_lifetime_earned -- only genuine
--    qualifying reward earnings (vc_reward_campaigns.counts_toward_lifetime)
--    or an admin credit explicitly flagged as replacement reward compensation
--    should move the lifetime/tier/multiplier needle.
-- 3. Root cause of "admin credited VC but lifetime/tier/UI didn't update":
--    admin_credit_vents_cents inserted directly into vc_transactions and never
--    called award_vc_reward(), so vc_lifetime_earned was structurally never
--    touched by it. Fixed below by giving admin_credit_vents_cents its own
--    explicit, auditable lifetime-counting flag instead of silently bypassing
--    the system -- not by routing it through award_vc_reward's campaign model,
--    since an admin credit is not tied to a campaign.
--
-- Reconciliation performed before writing this migration (read-only, see
-- chat record): sum(vents_wallets.balance) across all users = 100,498,840 VC.
-- That is comfortably below the new 1,000,000,000 VC supply, so no existing
-- balance is invalidated, reset, or rewritten by this migration -- it is
-- booked as a one-time pool debit representing VC already issued before pool
-- accounting existed, exactly mirroring the real-world amount outstanding.

-- 1) Single-row system/admin VC pool.
CREATE TABLE IF NOT EXISTS public.vc_system_pool (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  balance numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vc_system_pool ENABLE ROW LEVEL SECURITY;
-- No client-facing policies: the pool is read/written only through
-- SECURITY DEFINER functions below (and the admin aggregates RPC).

INSERT INTO public.vc_system_pool (id, balance)
VALUES (true, 1000000000)
ON CONFLICT (id) DO NOTHING;

-- 2) Auditable ledger of every pool movement: source/destination, amount,
--    reason, actor, reference (the vc_transactions row), timestamp, and the
--    resulting pool balance -- without duplicating vc_transactions itself.
CREATE TABLE IF NOT EXISTS public.vc_pool_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount numeric NOT NULL CHECK (amount > 0),
  user_id uuid REFERENCES public.users(id),
  vc_transaction_id uuid REFERENCES public.vc_transactions(id),
  reason text,
  actor uuid,
  balance_after numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vc_pool_ledger ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS vc_pool_ledger_user_id_idx ON public.vc_pool_ledger (user_id);
CREATE INDEX IF NOT EXISTS vc_pool_ledger_created_at_idx ON public.vc_pool_ledger (created_at);

-- 3) Internal helper: move the pool and record the ledger row in one place.
--    'debit' = pool shrinks (VC issued to a user). 'credit' = pool grows
--    (VC returned from a user: admin debit/claw-back, reward reversal).
--    Not granted to anon/authenticated -- only callable from other
--    SECURITY DEFINER functions owned by the same role.
CREATE OR REPLACE FUNCTION public._vc_pool_move(
  p_direction text,
  p_amount numeric,
  p_user_id uuid,
  p_vc_transaction_id uuid,
  p_reason text,
  p_actor uuid DEFAULT auth.uid()
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_balance numeric;
BEGIN
  IF p_direction NOT IN ('debit', 'credit') THEN
    RAISE EXCEPTION '_vc_pool_move: invalid direction %', p_direction;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION '_vc_pool_move: amount must be positive';
  END IF;

  SELECT balance INTO v_balance FROM public.vc_system_pool WHERE id = true FOR UPDATE;

  IF p_direction = 'debit' THEN
    IF v_balance < p_amount THEN
      RAISE EXCEPTION 'VENTS Cents system pool is exhausted (balance % < requested %)', v_balance, p_amount;
    END IF;
    v_balance := v_balance - p_amount;
  ELSE
    v_balance := v_balance + p_amount;
  END IF;

  UPDATE public.vc_system_pool SET balance = v_balance, updated_at = now() WHERE id = true;

  INSERT INTO public.vc_pool_ledger (direction, amount, user_id, vc_transaction_id, reason, actor, balance_after)
  VALUES (p_direction, p_amount, p_user_id, p_vc_transaction_id, p_reason, p_actor, v_balance);

  RETURN v_balance;
END;
$function$;

-- 4) One-time reconciliation: book the VC already outstanding before pool
--    accounting existed as a pool debit, so the pool reflects reality from
--    this point forward. No user balance, transaction, or lifetime value is
--    touched -- this only moves the pool's own counter.
DO $$
DECLARE
  v_outstanding numeric;
BEGIN
  SELECT COALESCE(sum(balance), 0) INTO v_outstanding FROM public.vents_wallets;
  IF v_outstanding > 0 THEN
    PERFORM public._vc_pool_move(
      'debit', v_outstanding, NULL, NULL,
      'Initial reconciliation: VC already outstanding prior to system-pool accounting (migration 0147)',
      NULL
    );
  END IF;
END $$;

-- 5) award_vc_reward now debits the pool for every genuine reward earn, in
--    the same transaction as the award itself (so a pool-exhaustion
--    exception rolls back the whole award, never a half-applied state).
CREATE OR REPLACE FUNCTION public.award_vc_reward(p_user_id uuid, p_campaign_key text, p_reference_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'active'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_campaign public.vc_reward_campaigns;
  v_user_count integer;
  v_tx_id uuid;
  v_multiplier numeric := 1.0;
  v_amount integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'award_vc_reward: user_id is required';
  END IF;
  IF p_status NOT IN ('active', 'pending') THEN
    RAISE EXCEPTION 'award_vc_reward: invalid status %', p_status;
  END IF;

  SELECT * INTO v_campaign FROM public.vc_reward_campaigns WHERE key = p_campaign_key FOR UPDATE;
  IF v_campaign IS NULL THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'unknown_campaign');
  END IF;
  IF NOT v_campaign.enabled THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'campaign_disabled');
  END IF;
  IF v_campaign.starts_at IS NOT NULL AND now() < v_campaign.starts_at THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'campaign_not_started');
  END IF;
  IF v_campaign.ends_at IS NOT NULL AND now() > v_campaign.ends_at THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'campaign_ended');
  END IF;

  IF v_campaign.cap_per_user IS NOT NULL THEN
    SELECT count(*) INTO v_user_count
    FROM public.vc_transactions
    WHERE user_id = p_user_id AND campaign_key = p_campaign_key AND type = 'earn' AND status <> 'cancelled';
    IF v_user_count >= v_campaign.cap_per_user THEN
      RETURN jsonb_build_object('awarded', false, 'reason', 'per_user_cap_reached');
    END IF;
  END IF;

  IF v_campaign.cap_total IS NOT NULL AND v_campaign.total_awarded >= v_campaign.cap_total THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'total_cap_reached');
  END IF;

  IF v_campaign.multiplier_eligible THEN
    SELECT multiplier INTO v_multiplier FROM public.vc_tier_and_multiplier_for_user(p_user_id);
    v_multiplier := COALESCE(v_multiplier, 1.0);
  END IF;
  v_amount := GREATEST(1, round(v_campaign.amount_vc * v_multiplier)::integer);

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, campaign_key, metadata)
  VALUES (p_user_id, v_amount, 'earn', p_status, p_reference_id, p_campaign_key, jsonb_build_object('campaign_label', v_campaign.label, 'base_amount_vc', v_campaign.amount_vc, 'multiplier', v_multiplier))
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
  END IF;

  PERFORM public._vc_pool_move('debit', v_amount, p_user_id, v_tx_id, 'reward:' || p_campaign_key, NULL);

  UPDATE public.vc_reward_campaigns SET total_awarded = total_awarded + 1 WHERE key = p_campaign_key;

  IF v_campaign.counts_toward_lifetime THEN
    UPDATE public.users SET vc_lifetime_earned = vc_lifetime_earned + v_amount WHERE id = p_user_id;
  END IF;

  RETURN jsonb_build_object('awarded', true, 'amount', v_amount, 'transaction_id', v_tx_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
END;
$function$;

-- 6) Admin credit: now pool-accounted, idempotent, and only counts toward
--    lifetime VC when the admin explicitly says so (p_counts_toward_lifetime).
--    Reuses the existing earn-dedup partial index (campaign_key IS NULL here,
--    same as before) for idempotency, so a duplicate submission with the same
--    idempotency key is a no-op replay rather than a second credit.
CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_user_id uuid,
  p_amount numeric,
  p_reason text,
  p_counts_toward_lifetime boolean DEFAULT false,
  p_idempotency_key uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_amount integer := p_amount::integer;
  v_tx_id uuid;
  v_rows integer;
  v_balance integer;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot credit your own Vents Cents balance';
  END IF;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at, metadata)
  VALUES (
    p_user_id, v_amount, 'earn', 'active', p_idempotency_key, now(),
    jsonb_build_object('source', 'admin_credit', 'reason', p_reason, 'counts_toward_lifetime', p_counts_toward_lifetime, 'actor', auth.uid())
  )
  ON CONFLICT (user_id, COALESCE(campaign_key, ''), reference_id) WHERE (type = 'earn' AND reference_id IS NOT NULL)
  DO NOTHING
  RETURNING id INTO v_tx_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'credited', v_amount, 'new_balance', COALESCE(v_balance, 0));
  END IF;

  PERFORM public._vc_pool_move('debit', v_amount, p_user_id, v_tx_id, 'admin_credit: ' || p_reason, auth.uid());

  IF p_counts_toward_lifetime THEN
    UPDATE public.users SET vc_lifetime_earned = vc_lifetime_earned + v_amount WHERE id = p_user_id;
  END IF;

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    v_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_vc_credit', p_user_id,
    jsonb_build_object('amount', v_amount, 'reason', p_reason, 'counts_toward_lifetime', p_counts_toward_lifetime, 'idempotency_key', p_idempotency_key),
    public.actor_role()
  );

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'credited', v_amount, 'new_balance', COALESCE(v_balance, 0), 'counts_toward_lifetime', p_counts_toward_lifetime);
END;
$function$;

-- 7) Admin debit: credits the amount back to the system pool (it is leaving
--    circulation, not being destroyed), gains the same idempotency-key
--    pattern, and continues to never touch vc_lifetime_earned -- spending
--    (including an admin claw-back) must not reduce tier, matching the
--    existing rule that VC spend/conversion never decrements lifetime.
CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(
  p_user_id uuid,
  p_amount integer,
  p_reason text DEFAULT 'Admin debit'::text,
  p_idempotency_key uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
  v_tx_id uuid;
  v_rows integer;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot debit your own Vents Cents balance';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id FOR UPDATE;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, reference_id, metadata)
  VALUES (
    p_user_id, p_amount, 'spend', 'spent', now(), p_idempotency_key,
    jsonb_build_object('source', 'admin_debit', 'reason', p_reason, 'actor', auth.uid())
  )
  ON CONFLICT (user_id, reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL)
  DO NOTHING
  RETURNING id INTO v_tx_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'debited', p_amount, 'target_balance', v_balance);
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient Vents Cents balance (has %, requested %)', v_balance, p_amount;
  END IF;

  UPDATE public.vents_wallets SET balance = balance - p_amount, updated_at = now() WHERE user_id = p_user_id;

  PERFORM public._vc_pool_move('credit', p_amount, p_user_id, v_tx_id, 'admin_debit: ' || p_reason, auth.uid());

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_vc_debit', p_user_id,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'idempotency_key', p_idempotency_key),
    public.actor_role()
  );

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'debited', p_amount, 'target_balance', v_balance);
END;
$function$;

-- 8) Reward reversals (refund/cancel of the underlying activity) now credit
--    back only the amount actually clawed back, keeping the pool consistent
--    with what genuinely returned from circulation. This does not change the
--    existing lifetime/tier behavior of reversals (out of scope for this
--    migration; tracked separately), only the pool side of the movement.
CREATE OR REPLACE FUNCTION public.reverse_vc_reward(p_reference_id uuid, p_reason text DEFAULT 'Underlying activity refunded/cancelled/invalidated'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row record;
  v_wallet_balance integer;
  v_actual_clawback integer;
BEGIN
  IF p_reference_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_row IN
    SELECT id, user_id, amount, campaign_key
    FROM public.vc_transactions
    WHERE reference_id = p_reference_id AND type = 'earn' AND status IN ('active', 'pending')
    FOR UPDATE
  LOOP
    UPDATE public.vc_transactions SET status = 'cancelled' WHERE id = v_row.id;

    IF v_row.amount > 0 THEN
      SELECT balance INTO v_wallet_balance FROM public.vents_wallets WHERE user_id = v_row.user_id FOR UPDATE;
      v_actual_clawback := LEAST(COALESCE(v_wallet_balance, 0), v_row.amount);

      IF v_actual_clawback > 0 THEN
        UPDATE public.vents_wallets SET balance = balance - v_actual_clawback, updated_at = now()
        WHERE user_id = v_row.user_id;

        PERFORM public._vc_pool_move('credit', v_actual_clawback, v_row.user_id, v_row.id, 'reversal: ' || p_reason, NULL);
      END IF;

      IF v_actual_clawback < v_row.amount THEN
        INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
        VALUES (
          NULL, 'vc_reward_reversal_shortfall', v_row.user_id,
          jsonb_build_object(
            'reference_id', p_reference_id, 'campaign_key', v_row.campaign_key,
            'owed_vc', v_row.amount, 'recovered_vc', v_actual_clawback,
            'shortfall_vc', v_row.amount - v_actual_clawback, 'reason', p_reason
          ),
          'webhook'
        );
      END IF;
    END IF;
  END LOOP;
END;
$function$;

-- 9) Admin-facing read helpers: pool status, and a per-user VC summary for
--    the "Current available VC" / "Projected balance" display. Server is the
--    sole source of truth for both numbers -- the client only ever echoes
--    what these return. (admin_get_vc_aggregates keeps its existing
--    signature; pool headroom is exposed separately via
--    admin_get_vc_pool_status() to avoid an OUT-parameter signature change
--    that would require dropping the existing function.)
CREATE OR REPLACE FUNCTION public.admin_get_vc_pool_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_pool_balance numeric;
  v_outstanding numeric;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT balance INTO v_pool_balance FROM public.vc_system_pool WHERE id = true;
  SELECT COALESCE(sum(balance), 0) INTO v_outstanding FROM public.vents_wallets;

  RETURN jsonb_build_object(
    'total_supply', 1000000000,
    'pool_balance', v_pool_balance,
    'total_user_vc_outstanding', v_outstanding
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_user_vc_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
  v_lifetime integer;
  v_tier text;
  v_multiplier numeric;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;
  SELECT lifetime_earned, tier, multiplier INTO v_lifetime, v_tier, v_multiplier
    FROM public.vc_tier_and_multiplier_for_user(p_user_id);

  RETURN jsonb_build_object(
    'balance', COALESCE(v_balance, 0),
    'lifetime_earned', COALESCE(v_lifetime, 0),
    'tier', v_tier,
    'multiplier', COALESCE(v_multiplier, 1.0)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_vc_pool_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_user_vc_summary(uuid) TO authenticated;

-- 10) Event check-in VC eligibility: ₦20,000 minimum ticket price, enforced
--     server-side off public.tickets.amount (the authoritative, server-set
--     amount actually paid for that ticket -- never a client-supplied
--     price). Free events and events below the threshold still check the
--     attendee in normally; only the VC award is skipped. The referrer
--     first-check-in reward is retargeted to the referred user's first
--     *qualifying* (>= 20,000) check-in, not merely their first check-in.
CREATE OR REPLACE FUNCTION public.manual_check_in(p_ticket_id uuid, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
  v_reason text;
  v_message text;
  v_is_first_qualifying_checkin boolean;
  v_referrer_id uuid;
  v_vc_eligible boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to check in as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('manual_checkin:' || p_actor_id::text, 30, 10);

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found'; v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(NULL, p_ticket_id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF NOT public.is_event_door_manager(v_ticket.event_id) THEN
    v_reason := 'wrong_organizer'; v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active'; v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already checked in.', p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already checked in.', p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, true)
  ON CONFLICT (ticket_id) DO NOTHING;

  v_vc_eligible := COALESCE(v_ticket.amount, 0) >= 20000;

  IF v_vc_eligible THEN
    PERFORM public.award_vc_reward(v_ticket.user_id, 'event_checkin', v_ticket.id, 'active');

    -- Batch C: referrer first-*qualifying*-check-in reward.
    SELECT (count(*) = 1) INTO v_is_first_qualifying_checkin
      FROM public.checkins c
      JOIN public.tickets t2 ON t2.id = c.ticket_id
     WHERE c.user_id = v_ticket.user_id AND COALESCE(t2.amount, 0) >= 20000;

    IF v_is_first_qualifying_checkin THEN
      SELECT reference_id INTO v_referrer_id FROM public.vc_transactions
       WHERE user_id = v_ticket.user_id AND campaign_key = 'referral_referred' AND type = 'earn' AND status = 'active'
       LIMIT 1;
      IF v_referrer_id IS NOT NULL THEN
        PERFORM public.award_vc_reward(v_referrer_id, 'referral_referrer_checkin', v_ticket.user_id, 'active');
      END IF;
    END IF;
  END IF;

  PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, true);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', true,
    'vc_awarded', v_vc_eligible,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_secret       text;
  v_seg1         text;
  v_seg2         text;
  v_expected_sig text;
  v_payload      jsonb;
  v_raw_id       text;
  v_ticket       record;
  v_log_event_id uuid;
  v_reason       text;
  v_message      text;
  v_is_first_qualifying_checkin boolean;
  v_referrer_id  uuid;
  v_vc_eligible  boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  IF p_ticket_id IS NULL OR strpos(p_ticket_id, '.') = 0 THEN
    v_reason := 'unsigned_ticket';
    v_message := 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (online) and rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_seg1 := split_part(p_ticket_id, '.', 1);
  v_seg2 := split_part(p_ticket_id, '.', 2);

  IF v_seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_reason := 'legacy_token';
    v_message := 'This pass uses an outdated format. Ask the attendee to reopen their ticket (online) to refresh it, then rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket verification secret is not configured';
  END IF;

  v_expected_sig := encode(extensions.hmac(v_seg1, v_secret, 'sha256'), 'hex');
  IF v_seg2 IS DISTINCT FROM v_expected_sig THEN
    v_reason := 'invalid_signature';
    v_message := 'This QR code failed cryptographic verification.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  BEGIN
    v_payload := convert_from(
      decode(translate(v_seg1, '-_', '+/') || repeat('=', (4 - length(v_seg1) % 4) % 4), 'base64'),
      'UTF8'
    )::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_reason := 'invalid_token';
    v_message := 'This QR code could not be read.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END;

  BEGIN
    v_log_event_id := (v_payload->>'eventId')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_log_event_id := NULL;
  END;

  IF (v_payload->>'version') IS DISTINCT FROM '2' THEN
    v_reason := 'invalid_token';
    v_message := 'Unsupported ticket version.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF (v_payload->>'expiresAt') IS NULL
     OR (v_payload->>'expiresAt')::timestamptz < now() THEN
    v_reason := 'expired';
    v_message := 'This ticket pass has expired.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_raw_id := v_payload->>'ticketId';

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found';
    v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_log_event_id := v_ticket.event_id;

  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    v_reason := 'payload_mismatch';
    v_message := 'This ticket pass does not match its event record.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin() THEN
    v_reason := 'wrong_organizer';
    v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active';
    v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, false)
  ON CONFLICT (ticket_id) DO NOTHING;

  v_vc_eligible := COALESCE(v_ticket.amount, 0) >= 20000;

  IF v_vc_eligible THEN
    PERFORM public.award_vc_reward(v_ticket.user_id, 'event_checkin', v_ticket.id, 'active');

    -- Batch C: referrer first-*qualifying*-check-in reward.
    SELECT (count(*) = 1) INTO v_is_first_qualifying_checkin
      FROM public.checkins c
      JOIN public.tickets t2 ON t2.id = c.ticket_id
     WHERE c.user_id = v_ticket.user_id AND COALESCE(t2.amount, 0) >= 20000;

    IF v_is_first_qualifying_checkin THEN
      SELECT reference_id INTO v_referrer_id FROM public.vc_transactions
       WHERE user_id = v_ticket.user_id AND campaign_key = 'referral_referred' AND type = 'earn' AND status = 'active'
       LIMIT 1;
      IF v_referrer_id IS NOT NULL THEN
        PERFORM public.award_vc_reward(v_referrer_id, 'referral_referrer_checkin', v_ticket.user_id, 'active');
      END IF;
    END IF;
  END IF;

  PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, false);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', false,
    'vc_awarded', v_vc_eligible,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;
