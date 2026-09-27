-- Master security audit (HIGH #1): claim_profile_bonus() had a TOCTOU
-- double-credit race. The "already claimed" guard was a plain
-- `SELECT EXISTS (... vc_bonuses ...)` check, not atomic with the
-- unconditional `INSERT INTO vc_transactions` that followed it. Two
-- near-simultaneous calls (a double-tap, or a scripted burst) could both
-- pass the EXISTS check before either committed, both insert a 100 VC
-- earn transaction, and only the vc_bonuses UNIQUE(user_id, bonus_type)
-- constraint would stop a THIRD insert -- the double-credit from the first
-- two calls already happened. Same bug class as the already-fixed
-- admin_credit_vents_cents double-credit (migration 0096), just in a
-- different function that fix never touched.
--
-- Fix, mirroring complete_referral's already-correct pattern: make the
-- real unique constraint the atomic gate. INSERT INTO vc_bonuses first
-- with ON CONFLICT DO NOTHING RETURNING id; only credit vc_transactions
-- IF FOUND (id returned). Two concurrent callers now race on the same
-- unique-constrained INSERT -- Postgres guarantees exactly one wins, the
-- loser gets NULL back and returns "already claimed" without ever
-- touching vc_transactions. Also adds check_rate_limit (every sibling
-- earn-path RPC -- complete_referral, purchase_ticket, verify_entry_pass,
-- manual_check_in, initiate_ticket_transfer -- already has one; this
-- function was the one earn-path missing it).
--
-- Eligibility check (avatar/bio/phone) and the profile lookup are
-- unchanged. The 100 VC award amount is unchanged.

CREATE OR REPLACE FUNCTION public.claim_profile_bonus()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id    uuid    := auth.uid();
  v_has_avatar boolean;
  v_has_bio    boolean;
  v_has_phone  boolean;
  v_bonus_id   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  PERFORM public.check_rate_limit('claim_profile_bonus:' || v_user_id::text, 5, 60);

  SELECT
    (avatar_url IS NOT NULL AND avatar_url <> ''),
    (bio IS NOT NULL AND length(trim(bio)) >= 10),
    (phone_number IS NOT NULL AND phone_number <> '')
  INTO v_has_avatar, v_has_bio, v_has_phone
  FROM public.users WHERE id = v_user_id;

  IF NOT (v_has_avatar AND v_has_bio AND v_has_phone) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Complete your profile first (photo, bio ≥10 chars, phone)');
  END IF;

  -- Atomic claim gate: the UNIQUE(user_id, bonus_type) constraint is the
  -- actual mutex. Only the caller that wins this INSERT ever credits VC.
  INSERT INTO public.vc_bonuses (user_id, bonus_type)
  VALUES (v_user_id, 'profile_complete')
  ON CONFLICT (user_id, bonus_type) DO NOTHING
  RETURNING id INTO v_bonus_id;

  IF v_bonus_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Profile bonus already claimed');
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at)
  VALUES (v_user_id, 100, 'earn', 'active', now());

  RETURN jsonb_build_object('success', true, 'vc_awarded', 100);
END;
$function$;
