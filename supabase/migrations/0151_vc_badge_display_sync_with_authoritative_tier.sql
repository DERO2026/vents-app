-- VENTS Cents: keep the legacy users.vc_badge column (still read directly
-- by ProfileScreen, UserProfileScreen, HomeScreen, ExploreScreen, and
-- ConversationScreen's <BadgeChip> for display) in sync with the
-- authoritative tier derived from vc_lifetime_earned, so "Profile" and
-- "VENTS Cents" never disagree about a user's tier again.
--
-- Concrete bug this fixes: migration 0150's Lifetime VC grandfather just
-- raised fc45414e (dero) to Legend tier (vc_tier_and_multiplier_for_user),
-- but that account's users.vc_badge column still read 'gold' -- a stale
-- value from the retired purchase_badge() era. Every screen above reads
-- vc_badge directly rather than calling vc_tier_and_multiplier_for_user(),
-- so Profile would have kept showing "Gold" while the VENTS Cents screen
-- correctly showed "Legend".
--
-- This does NOT create a second tier calculation system: vc_badge becomes
-- a synced cache of the one existing authoritative function
-- (vc_tier_for_lifetime()), never computed independently. Going forward,
-- award_vc_reward() and admin_credit_vents_cents() (the only two functions
-- that can ever change vc_lifetime_earned) now also refresh vc_badge in the
-- same statement whenever lifetime changes, so this can never drift again.
--
-- Backfill is scoped to exactly the four accounts migration 0150 touched --
-- not a blanket update -- so the admin/sub-admin/house/test accounts this
-- task was told never to modify remain untouched here too.

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
    UPDATE public.users
       SET vc_lifetime_earned = vc_lifetime_earned + v_amount,
           vc_badge = public.vc_tier_for_lifetime(vc_lifetime_earned + v_amount)
     WHERE id = p_user_id;
  END IF;

  RETURN jsonb_build_object('awarded', true, 'amount', v_amount, 'transaction_id', v_tx_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
END;
$function$;

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
    UPDATE public.users
       SET vc_lifetime_earned = vc_lifetime_earned + v_amount,
           vc_badge = public.vc_tier_for_lifetime(vc_lifetime_earned + v_amount)
     WHERE id = p_user_id;
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

-- One-time backfill, scoped to exactly the four accounts migration 0150
-- grandfathered -- not a blanket update over every user.
UPDATE public.users
   SET vc_badge = public.vc_tier_for_lifetime(vc_lifetime_earned)
 WHERE id IN (
   'fc45414e-6aef-494f-bbb4-b373dac5196b',
   '838beb9c-5ec6-455b-9420-295b8007358e',
   '711b8a48-f06d-479f-9191-2fb33c76f291',
   '00a75bc6-097a-40a6-96d5-966fdc54dc1f'
 );
