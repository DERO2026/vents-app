-- Two missing-notification gaps:
--
-- 1. complete_referral() never notified either party — a referrer had no
--    way to know their invite link actually worked and 300 VC was pending,
--    and the referred user had no confirmation their 150 VC landed.
--
-- 2. admin_credit_vents_cents has two live overloads (by argument type).
--    The (uuid, integer, text) overload already notifies the credited user
--    (migrations/20260625063708_admin-guard-credit-and-role.sql). The
--    (uuid, numeric, text) overload — the one actually wired to the admin
--    dashboard's more commonly-used "VC Admin Transfer" panel
--    (AdminDashboardScreen.tsx handleVcAdminTransfer) — does not. Adding
--    the same notification pattern here.

CREATE OR REPLACE FUNCTION public.complete_referral(p_referrer_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referred_id uuid := auth.uid();
  v_referrer_id uuid;
  v_new_row_id  uuid;
  v_referred_name text;
BEGIN
  IF v_referred_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT id INTO v_referrer_id
  FROM public.users
  WHERE upper(substr(id::text, 1, 8)) = upper(p_referrer_code)
  LIMIT 1;

  IF v_referrer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid referral code');
  END IF;

  IF v_referrer_id = v_referred_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot use your own code');
  END IF;

  -- 150 VC to the new user immediately. This INSERT is the real
  -- idempotency gate: vc_transactions_referral_dedup_idx makes a second
  -- concurrent/duplicate call for the same (referred, referrer) pair
  -- conflict here and insert nothing, so only one caller ever proceeds
  -- past this point — no separate read-then-write race window.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referred_id, 150, 'referral', 'active', v_referrer_id, now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING
  RETURNING id INTO v_new_row_id;

  IF v_new_row_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

  -- 300 VC to referrer pending 14 days (pending rows don't trigger wallet
  -- update). Guarded by the same unique index, scoped to the referrer's
  -- own user_id — belt-and-suspenders, since reaching this line already
  -- implies the line above won the race for this referral event.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referrer_id, 300, 'referral', 'pending', v_referred_id, now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING;

  INSERT INTO public.referrals (referrer_id, invitee_email, status)
  VALUES (
    v_referrer_id,
    (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1),
    'joined'
  )
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(full_name, username, 'Someone') INTO v_referred_name
  FROM public.users WHERE id = v_referred_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referred_id, 'promo', 'Referral Bonus', '+150 Vents Cents added to your wallet for joining via a referral link.', false, '🎉');

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referrer_id, 'promo', 'Referral Joined', v_referred_name || ' joined using your referral link! 300 Vents Cents pending (available in 14 days).', false, '🤝');

  RETURN jsonb_build_object('success', true, 'awarded_to_you', 150, 'referrer_pending', 300);
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_referral(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(
  p_user_id uuid,
  p_amount  numeric,
  p_reason  text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.vents_wallets (user_id, balance)
  VALUES (p_user_id, p_amount::integer)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.vents_wallets.balance + p_amount::integer, updated_at = now();

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  RETURN 'ok';
END;
$$;
