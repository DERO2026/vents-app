-- Fix: 0126 introduced a 'reversed' status for reversed VC rewards, but
-- vc_transactions_status_check only allows ('active','pending','expired',
-- 'spent','cancelled') -- caught by live verification before any refund hit
-- production. Use 'cancelled' instead, which already exists and fits the
-- semantics (an earn row that no longer counts).

CREATE OR REPLACE FUNCTION public.award_vc_reward(
  p_user_id uuid,
  p_campaign_key text,
  p_reference_id uuid DEFAULT NULL,
  p_status text DEFAULT 'active'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_campaign public.vc_reward_campaigns;
  v_user_count integer;
  v_tx_id uuid;
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

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, campaign_key, metadata)
  VALUES (p_user_id, v_campaign.amount_vc, 'earn', p_status, p_reference_id, p_campaign_key, jsonb_build_object('campaign_label', v_campaign.label))
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
  END IF;

  UPDATE public.vc_reward_campaigns SET total_awarded = total_awarded + 1 WHERE key = p_campaign_key;

  RETURN jsonb_build_object('awarded', true, 'amount', v_campaign.amount_vc, 'transaction_id', v_tx_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_vc_reward(
  p_reference_id uuid,
  p_reason text DEFAULT 'Underlying activity refunded/cancelled/invalidated'
) RETURNS void
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
