-- Fix double-crediting race in complete_referral().
--
-- Reported symptom: a referrer requests/expects 300 VC and receives 600.
-- Root cause: complete_referral() used a non-atomic "check, then insert"
-- pattern — SELECT ... EXISTS to see if this referral was already applied,
-- and only if not, INSERT the two credit rows. vc_transactions had no
-- unique constraint backing that check, so two overlapping calls for the
-- same (referred_id, referrer_id) pair (e.g. the fire-and-forget RPC call
-- in AuthScreen.tsx retried by the network layer, or the same referral
-- code applied from two tabs/devices before either commits) could both
-- pass the EXISTS check and both insert, doubling both the referred
-- user's 150 VC and the referrer's 300 VC.
--
-- Fix: the (referred_id, referrer_id) pair IS the natural unique
-- "transaction id" for a referral event — a specific referred user can
-- only ever be referred by a specific referrer once. Add a real unique
-- index enforcing that, and rewrite the function to gate on
-- INSERT ... ON CONFLICT DO NOTHING RETURNING id rather than a
-- check-then-act read, so the database itself — not application logic —
-- guarantees only one of any number of concurrent/duplicate calls
-- succeeds.

CREATE UNIQUE INDEX IF NOT EXISTS vc_transactions_referral_dedup_idx
  ON public.vc_transactions (user_id, reference_id)
  WHERE type = 'referral';

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

  RETURN jsonb_build_object('success', true, 'awarded_to_you', 150, 'referrer_pending', 300);
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_referral(text) TO authenticated;
