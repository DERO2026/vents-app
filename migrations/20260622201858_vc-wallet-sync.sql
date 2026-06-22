-- VC Wallet Sync
-- 1. Trigger to sync vc_transactions INSERT → vents_wallets.balance
-- 2. claim_profile_bonus() - 100 VC one-time for completing profile
-- 3. complete_referral() - 150 VC to new user, 300 VC pending to referrer
-- 4. One-time reconcile for existing vc_transactions not yet in wallet

-- 1. Trigger function
CREATE OR REPLACE FUNCTION public.trg_sync_vc_to_wallet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.type IN ('earn', 'referral') AND NEW.status = 'active' THEN
    INSERT INTO public.vents_wallets (user_id, balance, updated_at)
    VALUES (NEW.user_id, NEW.amount, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance    = vents_wallets.balance + NEW.amount,
          updated_at = now();
  ELSIF NEW.type = 'spend' AND NEW.status = 'active' THEN
    UPDATE public.vents_wallets
    SET balance    = GREATEST(0, balance - NEW.amount),
        updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vc_wallet_sync ON public.vc_transactions;
CREATE TRIGGER trg_vc_wallet_sync
  AFTER INSERT ON public.vc_transactions
  FOR EACH ROW EXECUTE FUNCTION public.trg_sync_vc_to_wallet();

-- 2. claim_profile_bonus: 100 VC for completing avatar + bio + phone (one-time)
CREATE OR REPLACE FUNCTION public.claim_profile_bonus()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    uuid    := auth.uid();
  v_has_avatar boolean;
  v_has_bio    boolean;
  v_has_phone  boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  IF EXISTS (SELECT 1 FROM public.vc_bonuses WHERE user_id = v_user_id AND bonus_type = 'profile_complete') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Profile bonus already claimed');
  END IF;

  SELECT
    (avatar_url IS NOT NULL AND avatar_url <> ''),
    (bio IS NOT NULL AND length(trim(bio)) >= 10),
    (phone_number IS NOT NULL AND phone_number <> '')
  INTO v_has_avatar, v_has_bio, v_has_phone
  FROM public.users WHERE id = v_user_id;

  IF NOT (v_has_avatar AND v_has_bio AND v_has_phone) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Complete your profile first (photo, bio ≥10 chars, phone)');
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at)
  VALUES (v_user_id, 100, 'earn', 'active', now());

  INSERT INTO public.vc_bonuses (user_id, bonus_type)
  VALUES (v_user_id, 'profile_complete')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('success', true, 'vc_awarded', 100);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_profile_bonus() TO authenticated;

-- 3. complete_referral: 150 VC to referred (active), 300 VC to referrer (pending 14d)
CREATE OR REPLACE FUNCTION public.complete_referral(p_referrer_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referred_id uuid := auth.uid();
  v_referrer_id uuid;
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

  IF EXISTS (
    SELECT 1 FROM public.vc_transactions
    WHERE user_id = v_referred_id AND type = 'referral' AND reference_id = v_referrer_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

  -- 150 VC to new user immediately
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referred_id, 150, 'referral', 'active', v_referrer_id, now());

  -- 300 VC to referrer pending 14 days (pending rows don't trigger wallet update)
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referrer_id, 300, 'referral', 'pending', v_referred_id, now());

  INSERT INTO public.referrals (referrer_id, invitee_email, status)
  VALUES (
    v_referrer_id,
    (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1),
    'joined'
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('success', true, 'awarded_to_you', 150, 'referrer_pending', 300);
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_referral(text) TO authenticated;

-- 4. Reconcile: add only the missing delta (tx_active - wallet_bal) where wallet is behind
WITH tx_sums AS (
  SELECT user_id, COALESCE(SUM(amount), 0)::integer AS tx_active
  FROM public.vc_transactions
  WHERE type IN ('earn', 'referral') AND status = 'active'
  GROUP BY user_id
)
UPDATE public.vents_wallets w
SET balance    = w.balance + (t.tx_active - w.balance),
    updated_at = now()
FROM tx_sums t
WHERE t.user_id = w.user_id
  AND t.tx_active > w.balance;
