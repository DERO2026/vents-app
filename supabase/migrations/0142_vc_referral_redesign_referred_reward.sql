-- Batch C: replace the old, pre-campaign-framework referred-user reward
-- (direct `INSERT INTO vc_transactions (..., 150, 'referral', 'active', ...)`
-- with the dedup index `vc_transactions_referral_dedup_idx` on
-- (user_id, reference_id) WHERE type='referral') with a flat 500 VC award
-- routed through the central award_vc_reward()/campaign framework.
--
-- Already applied live to production (project slrtjxtzhowhwhebjprv) via
-- the Supabase MCP apply_migration tool, under the live migration name
-- `vc_referral_redesign_referred_reward`. This file mirrors that change
-- for the repo per this project's established convention (see 0138/0139).
--
-- The old dedup index only ever blocked reusing the SAME referrer's code
-- twice (unique on (user_id, reference_id), where reference_id was the
-- specific referrer's id) -- it did NOT stop a user from applying two
-- DIFFERENT referral codes from two different referrers and collecting the
-- bonus twice. Routing through award_vc_reward() against the
-- referral_referred campaign (cap_per_user = 1, unaffected by this
-- migration) closes that gap: a user can now earn this reward at most
-- once, ever, regardless of how many different codes they try. This is a
-- tightening, not a weakening, of the existing anti-abuse posture.
--
-- The referrer's old 300 VC / 14-day-pending reward is REMOVED from this
-- function entirely (no more direct vc_transactions insert, no more
-- 'pending' status row). It is replaced by the new
-- referral_referrer_checkin campaign, awarded from verify_entry_pass /
-- manual_check_in (see migration 0143) only once the referred user
-- completes their first real check-in -- not at signup. This migration
-- does not retroactively touch any existing vc_transactions row; the one
-- pre-existing legacy referral transaction in production (id
-- 205c3abe-af1e-4635-83bd-8c2a8751301a, already active, pre-dating the
-- campaign framework) is left exactly as-is.
--
-- check_and_clear_pending_vc() is NOT touched or removed here: it is
-- generic shared infrastructure for any 'pending' vc_transactions row
-- (keyed by the ticket-refund check in its body, not anything
-- referral-specific), not referral-only code, and production currently
-- has zero pending rows -- this migration simply stops being a producer
-- of new pending referral rows, per the "retire/replace only the
-- referral-specific behavior" instruction.
--
-- Separately noted, not touched by this migration: a vestigial
-- `referral_referrer` campaign row (seeded in 0126, labeled "held pending
-- for 14 days") exists in vc_reward_campaigns but has zero call sites
-- anywhere in the codebase -- it predates the campaign framework actually
-- being wired to anything and was never an active duplicate-reward path.
-- Left as-is: not in this batch's scope, and inert either way.
--
-- self-referral protection, the two rate-limit checks, and the referrer
-- id lookup by code are all preserved unchanged.
CREATE OR REPLACE FUNCTION public.complete_referral(p_referrer_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_referred_id uuid := auth.uid();
  v_referrer_id uuid;
  v_referred_name text;
  v_award jsonb;
BEGIN
  IF v_referred_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  PERFORM public.check_rate_limit('complete_referral:' || v_referred_id::text, 5, 3600);
  PERFORM public.check_rate_limit('complete_referral:ip:' || public.client_ip(), 20, 3600);

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

  -- reference_id = the referrer's id: this is both the per-referral
  -- dedup key for this earn (via the existing vc_transactions_earn_dedup_idx)
  -- and the durable, queryable link the check-in trigger (0143) uses to find
  -- "who referred this user" later, without needing a new column anywhere.
  v_award := public.award_vc_reward(v_referred_id, 'referral_referred', v_referrer_id, 'active');

  IF NOT COALESCE((v_award->>'awarded')::boolean, false) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

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
  VALUES (v_referred_id, 'promo', 'Referral Bonus',
    '+' || (v_award->>'amount') || ' Vents Cents added to your wallet for joining via a referral link.', false, '🎉');

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referrer_id, 'promo', 'Referral Joined',
    v_referred_name || ' joined using your referral link! You''ll earn bonus Vents Cents (scaled by your badge tier) once they check into their first event.', false, '🤝');

  RETURN jsonb_build_object('success', true, 'awarded_to_you', (v_award->>'amount')::integer);
END;
$function$;

-- Flat 500 VC, no multiplier (multiplier_eligible stays false), counts
-- toward lifetime (unchanged from Batch A), cap_per_user stays 1.
UPDATE public.vc_reward_campaigns SET amount_vc = 500 WHERE key = 'referral_referred';
