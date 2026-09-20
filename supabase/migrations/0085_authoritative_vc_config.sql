-- ============================================================================
-- VENTS Cents Batch F1 -- Authoritative VC config + wallet referral
-- qualification fix.
--
-- Implements two of the recommendations from the read-only Batch F audit:
--
-- (1) A single authoritative server-side VC config source. Per the task
--     brief's explicit direction ("do NOT blindly duplicate the existing
--     SQL literals into a second RPC"), the 7 currently hardcoded-in-
--     SQL-body amounts (profile completion reward, ticket purchase reward,
--     referral referred/referrer rewards, referrer hold days, badge
--     bronze/silver/gold prices, Feature Me cost/duration, event boost
--     cost/duration) are migrated INTO new app_config columns, and the
--     real earn/spend RPCs are re-pointed at those same columns via
--     CREATE OR REPLACE -- so there is exactly one place these numbers
--     live, not two. A new get_vc_config() then reads the very same
--     columns (both these new ones and the pre-existing cash-out columns)
--     and is the one RPC any client/AI caller should ever use to learn a
--     current VC number, instead of hardcoding one.
--
--     Explicitly NOT touched (Category B -- structural/security rules,
--     not economy config): the referral cap (5) and the referral velocity
--     cap (3-per-24h) in complete_referral(), all dedup indexes/ON
--     CONFLICT arbiters, advisory locks, and every existing grant/
--     authorization boundary. These remain exactly as hardcoded/structural
--     as they were.
--
-- (2) A real bug: wallet-funded ticket purchases (confirm_ticket_payment_
--     via_wallet, supabase/migrations/0083) never call qualify_referral(),
--     while the card path (confirm_ticket_payment(), migrations/
--     20260808120000) does, inside its `IF v_total_amount > 0` branch. A
--     referred user who pays for their first ticket via wallet balance
--     therefore never has their pending 150 VC referral reward activated,
--     and their referrer's linked 300 VC never becomes eligible to mature.
--     Fixed by adding the identical `PERFORM public.qualify_referral(...)`
--     call to confirm_ticket_payment_via_wallet(), in the same logical
--     position (inside its own non-free-amount branch), changing nothing
--     else in that function. qualify_referral() itself (latest: supabase/
--     migrations/0084, which added activated_at) is reused unmodified --
--     its own idempotency guard (`WHERE status='pending' AND
--     qualifying_ticket_id IS NULL`) already prevents double-credit
--     regardless of caller, and Batch C's ticket-reward dedup index and
--     Batch D's maturation activated_at logic both live inside that same
--     shared function, so they automatically cover wallet-triggered
--     qualification too.
--
-- ── Objective 2 investigation (vc_naira_per_1000 / vc_min_ticket_price /
--    vc_max_redemption_pct) ──────────────────────────────────────────────
-- Grepped across the whole codebase (SQL functions in migrations/ and
-- supabase/migrations/, and every src/**/*.tsx|ts file):
--   * vc_naira_per_1000 is read by exactly one place in application code:
--     src/app/components/ReferralScreen.tsx, which selects it from
--     app_config and uses it purely for a display-only "≈ ₦X in ticket
--     credit" estimate next to a user's VC balance. No SQL function reads
--     it, and no redemption/spend RPC is wired to it -- it computes a
--     number shown on screen and nothing else.
--   * vc_min_ticket_price and vc_max_redemption_pct are read by NOTHING --
--     no SQL function, no frontend file, anywhere in this repository.
--     They are dead remnants of a VC-ticket-redemption feature that no
--     longer exists in this codebase (there is no RPC that redeems VC
--     against a ticket price today; the only VC "spends" are
--     purchase_badge, feature_in_people_vc, boost_event_vc, and
--     request_vc_cashout, none of which reference either column).
-- Treatment (additive only, per this task's explicit instruction not to
-- drop anything): get_vc_config() below exposes vc_naira_per_1000 under
-- the clearly-labeled, structurally-separate field name
-- `ticket_credit_display_estimate_rate` (never near/confusable with the
-- real cash-out field `cashout_rate_naira_per_1000`), and does NOT expose
-- vc_min_ticket_price or vc_max_redemption_pct at all, since they
-- represent a feature that does not exist and surfacing them would be
-- actively misleading. Both dead columns are additionally documented via
-- COMMENT ON COLUMN below. vc_cashout_naira_per_1000 and all Batch D
-- cash-out behavior are completely untouched.
--
-- ── Objective 1 badge-tier note (evidence-based, not blindly following
--    the brief) ───────────────────────────────────────────────────────────
-- The task brief describes purchase_badge() as having only bronze/silver/
-- gold support, citing migrations/20260620221549 as "latest". Independent
-- verification here found a LATER migration, migrations/20260622092226_
-- update-purchase-badge.sql (and the deployed snapshot in supabase/
-- migrations/0004_functions.sql, which reflects it), that replaced
-- purchase_badge() with a 6-tier version (bronze/silver/gold/platinum/
-- elite/legend) backed by a real CHECK constraint allowing all six values
-- (migrations/20260622080951_badge-tiers-platinum-elite-legend.sql). So
-- platinum/elite/legend DO have real backend support today, contradicting
-- the brief's premise. Per the brief's own explicit, enumerated list of
-- new app_config columns to add (bronze/silver/gold only), this migration
-- moves ONLY those three tiers' prices into config and re-points
-- purchase_badge() to read them for exactly those three tiers, leaving
-- platinum/elite/legend's prices (5000/12000/25000) hardcoded exactly as
-- they are today -- deliberately not expanding scope beyond what was
-- asked, but flagging this discrepancy plainly here and in this task's
-- final report rather than silently going along with an inaccurate
-- premise.
-- ============================================================================

-- ── 1. New app_config columns (additive, defaults match current literals
--       exactly, so behavior is unchanged until anyone edits them) ─────────
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_profile_completion_reward integer NOT NULL DEFAULT 100;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_ticket_purchase_reward integer NOT NULL DEFAULT 50;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_referral_referred_reward integer NOT NULL DEFAULT 150;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_referral_referrer_reward integer NOT NULL DEFAULT 300;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_referral_referrer_hold_days integer NOT NULL DEFAULT 14;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_badge_bronze_price integer NOT NULL DEFAULT 300;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_badge_silver_price integer NOT NULL DEFAULT 800;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_badge_gold_price integer NOT NULL DEFAULT 2000;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_feature_me_cost integer NOT NULL DEFAULT 150;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_feature_me_duration_days integer NOT NULL DEFAULT 3;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_event_boost_cost integer NOT NULL DEFAULT 1000;
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_event_boost_duration_days integer NOT NULL DEFAULT 3;

-- ── 1b. Document the two dead columns instead of dropping them ─────────────
COMMENT ON COLUMN public.app_config.vc_min_ticket_price IS
  'Deprecated/dead: unused since the VC-ticket-redemption feature was removed. No SQL function or frontend file reads this column (verified by repo-wide grep, VENTS Cents Batch F1). Deliberately not read by get_vc_config() -- exposing it would imply a redemption feature that does not exist. Not dropped; additive-only migration policy.';
COMMENT ON COLUMN public.app_config.vc_max_redemption_pct IS
  'Deprecated/dead: unused since the VC-ticket-redemption feature was removed. No SQL function or frontend file reads this column (verified by repo-wide grep, VENTS Cents Batch F1). Deliberately not read by get_vc_config() -- exposing it would imply a redemption feature that does not exist. Not dropped; additive-only migration policy.';

-- ── 2. Re-point the 8 earn/spend RPCs at the new config columns ───────────

-- claim_profile_bonus -- was: hardcoded 100. Every other check/insert is
-- byte-for-byte unchanged from migrations/20260622201858_vc-wallet-sync.sql.
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
  v_reward     integer;
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

  SELECT vc_profile_completion_reward INTO v_reward FROM public.app_config LIMIT 1;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at)
  VALUES (v_user_id, v_reward, 'earn', 'active', now());

  INSERT INTO public.vc_bonuses (user_id, bonus_type)
  VALUES (v_user_id, 'profile_complete')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('success', true, 'vc_awarded', v_reward);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_profile_bonus() TO authenticated;

-- complete_referral -- was: hardcoded 150 / 300. Referral cap (5) and
-- velocity cap (3/24h), the advisory lock, and every other line are
-- byte-for-byte unchanged from migrations/20260807120000_referral-
-- economy-integrity.sql (Category B -- left exactly as-is).
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
  v_joined_count integer;
  v_recent_count integer;
  v_referred_reward integer;
  v_referrer_reward integer;
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

  -- Fix 2 (unchanged, Category B): serialize every complete_referral()
  -- call for this referrer.
  PERFORM pg_advisory_xact_lock(hashtextextended('complete_referral:' || v_referrer_id::text, 0));

  SELECT count(*) INTO v_joined_count
  FROM public.referrals
  WHERE referrer_id = v_referrer_id AND status = 'joined';

  -- Referral cap: unchanged, hardcoded structural rule (Category B) --
  -- deliberately NOT moved to config.
  IF v_joined_count >= 5 THEN
    RETURN jsonb_build_object('success', false, 'message', 'This referral code has reached its maximum number of uses');
  END IF;

  -- Velocity cap: unchanged, hardcoded structural rule (Category B) --
  -- deliberately NOT moved to config.
  SELECT count(*) INTO v_recent_count
  FROM public.referrals
  WHERE referrer_id = v_referrer_id
    AND status = 'joined'
    AND created_at > now() - INTERVAL '24 hours';

  IF v_recent_count >= 3 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Too many referrals completed for this code recently, please try again later');
  END IF;

  SELECT vc_referral_referred_reward, vc_referral_referrer_reward
    INTO v_referred_reward, v_referrer_reward
  FROM public.app_config LIMIT 1;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, referral_role, earned_at)
  VALUES (v_referred_id, v_referred_reward, 'referral', 'pending', v_referrer_id, 'referred', now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING
  RETURNING id INTO v_new_row_id;

  IF v_new_row_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, referral_role, earned_at)
  VALUES (v_referrer_id, v_referrer_reward, 'referral', 'pending', v_referred_id, 'referrer', now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING;

  INSERT INTO public.referrals (referrer_id, invitee_email, status, referred_id)
  VALUES (
    v_referrer_id,
    (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1),
    'joined',
    v_referred_id
  )
  ON CONFLICT DO NOTHING;

  UPDATE public.referrals
  SET referred_id = v_referred_id, status = 'joined'
  WHERE referrer_id = v_referrer_id
    AND referred_id IS NULL
    AND invitee_email = (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1);

  RETURN jsonb_build_object(
    'success', true,
    'awarded_to_you', v_referred_reward,
    'awarded_to_you_status', 'pending',
    'message', 'Your ' || v_referred_reward || ' VC will unlock once you complete your first ticket purchase',
    'referrer_pending', v_referrer_reward
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_referral(text) TO authenticated;

-- confirm_ticket_payment (card path) -- was: hardcoded 50 for the reward
-- amount. Every other line (overpayment tolerance, dedup arbiter from
-- Batch C, organizer credit, promo redemption, qualify_referral hook,
-- notifications) is byte-for-byte unchanged from migrations/
-- 20260808120000_ticket-reward-integrity.sql.
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
  v_reward          integer;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    SELECT vc_ticket_purchase_reward INTO v_reward FROM public.app_config LIMIT 1;

    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, v_reward, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT (user_id, reference_id) WHERE type = 'earn' DO NOTHING;

    PERFORM public.qualify_referral(v_user_id, v_first_ticket_id);
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id)
  );

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) TO project_admin;

-- confirm_ticket_payment_via_wallet (wallet path) -- Objective 3's real
-- fix (the added qualify_referral PERFORM) PLUS Objective 1's re-pointed
-- reward amount, applied together in one CREATE OR REPLACE since both
-- touch this same function. Every other line (finalize_pending_purchase
-- call, wallet debit/insufficient-balance check, dedup arbiter from 0083,
-- organizer credit, promo redemption, notifications, error hardening from
-- 0075) is byte-for-byte unchanged from supabase/migrations/
-- 0083_wallet_ticket_reward_dedup.sql.
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment_via_wallet(p_payment_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid             uuid := auth.uid();
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
  v_holder_name     text;
  v_holder_email    text;
  v_holder_phone    text;
  v_metadata        jsonb;
  v_wallet_balance  bigint;
  v_tx_id           uuid;
  v_reward          integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Pending purchase not found for reference%' THEN
      RAISE WARNING 'confirm_ticket_payment_via_wallet: finalize_pending_purchase failed unexpectedly for %: %', p_payment_ref, SQLERRM;
      RAISE;
    END IF;
  END;

  PERFORM 1 FROM public.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_payment_ref
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this payment reference';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_expected_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_expected_kobo::text;
  END IF;

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
  VALUES (v_uid, 'spend', v_expected_kobo, 'Ticket purchase: ' || v_ticket_type, p_payment_ref)
  ON CONFLICT (reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.user_wallets
     SET balance_kobo = balance_kobo - v_expected_kobo, updated_at = now()
   WHERE user_id = v_uid;

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'wallet'
   WHERE payment_ref = p_payment_ref AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),
      'wallet_reference', p_payment_ref,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale (Wallet): ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    SELECT vc_ticket_purchase_reward INTO v_reward FROM public.app_config LIMIT 1;

    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, v_reward, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT (user_id, reference_id) WHERE type = 'earn' DO NOTHING;

    -- Objective 3 FIX: the wallet path previously never called this,
    -- unlike confirm_ticket_payment() (card path) above -- a referred user
    -- paying with wallet balance never activated their pending referral
    -- VC. Identical call, identical position (inside the same
    -- non-free-amount branch) as the card path. qualify_referral()'s own
    -- guard (status='pending' AND qualifying_ticket_id IS NULL) already
    -- makes this idempotent/safe against duplicate calls for the same
    -- order, and a free (v_total_amount = 0) wallet ticket never enters
    -- this branch at all, so it cannot qualify a referral either --
    -- matching the card path's behavior exactly.
    PERFORM public.qualify_referral(v_user_id, v_first_ticket_id);
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id, 'ticketId', v_first_ticket_id)
  );

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_ticket_payment_via_wallet(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment_via_wallet(text) TO authenticated;

-- _sweep_referral_vc -- was: hardcoded 14-day interval for the referrer's
-- pending -> active activation. Every other line (the refund/cancel loop,
-- the qualified_at check, SKIP LOCKED, wallet credit/debit) is
-- byte-for-byte unchanged from migrations/20260807120000_referral-
-- economy-integrity.sql.
CREATE OR REPLACE FUNCTION public._sweep_referral_vc(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row            record;
  v_activated      integer := 0;
  v_activated_vc   integer := 0;
  v_cancelled      integer := 0;
  v_cancelled_vc   integer := 0;
  v_hold_days      integer;
BEGIN
  SELECT vc_referral_referrer_hold_days INTO v_hold_days FROM public.app_config LIMIT 1;

  FOR v_row IN
    SELECT t.id, t.user_id, t.amount, t.status
    FROM public.vc_transactions t
    JOIN public.tickets tk ON tk.id = t.qualifying_ticket_id
    WHERE t.type = 'referral'
      AND t.status IN ('pending', 'active')
      AND tk.payment_status = 'refunded'
      AND (p_user_id IS NULL OR t.user_id = p_user_id)
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    IF v_row.status = 'active' THEN
      UPDATE public.vents_wallets
      SET balance = GREATEST(0, balance - v_row.amount), updated_at = now()
      WHERE user_id = v_row.user_id;
    END IF;

    UPDATE public.vc_transactions SET status = 'cancelled' WHERE id = v_row.id;

    v_cancelled := v_cancelled + 1;
    v_cancelled_vc := v_cancelled_vc + v_row.amount;
  END LOOP;

  FOR v_row IN
    SELECT t.id, t.user_id, t.amount
    FROM public.vc_transactions t
    JOIN public.referrals r ON r.referred_id = t.reference_id AND r.referrer_id = t.user_id
    WHERE t.type = 'referral'
      AND t.referral_role = 'referrer'
      AND t.status = 'pending'
      AND t.earned_at < now() - make_interval(days => v_hold_days)
      AND r.qualified_at IS NOT NULL
      AND (p_user_id IS NULL OR t.user_id = p_user_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.tickets tk
        WHERE tk.id = t.qualifying_ticket_id AND tk.payment_status = 'refunded'
      )
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    UPDATE public.vc_transactions SET status = 'active' WHERE id = v_row.id;

    INSERT INTO public.vents_wallets (user_id, balance, updated_at)
    VALUES (v_row.user_id, v_row.amount, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = vents_wallets.balance + v_row.amount, updated_at = now();

    v_activated := v_activated + 1;
    v_activated_vc := v_activated_vc + v_row.amount;
  END LOOP;

  RETURN jsonb_build_object(
    'activated_rows', v_activated, 'activated_vc', v_activated_vc,
    'cancelled_rows', v_cancelled, 'cancelled_vc', v_cancelled_vc
  );
END;
$$;

-- purchase_badge -- was: hardcoded 300/800/2000 for bronze/silver/gold
-- (platinum/elite/legend intentionally left hardcoded -- see the note
-- above this migration's header). Every other check (downgrade guard,
-- tier ordering, vc_bonuses upsert) is byte-for-byte unchanged from
-- migrations/20260622092226_update-purchase-badge.sql.
CREATE OR REPLACE FUNCTION public.purchase_badge(p_badge_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid        uuid    := auth.uid();
  v_cost       integer;
  v_tier_order text[]  := ARRAY['bronze','silver','gold','platinum','elite','legend'];
  v_current_idx integer;
  v_new_idx     integer;
  v_bronze integer;
  v_silver integer;
  v_gold   integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_badge_type NOT IN ('bronze','silver','gold','platinum','elite','legend') THEN
    RAISE EXCEPTION 'Invalid badge type: %', p_badge_type;
  END IF;

  SELECT vc_badge_bronze_price, vc_badge_silver_price, vc_badge_gold_price
    INTO v_bronze, v_silver, v_gold
  FROM public.app_config LIMIT 1;

  v_cost := CASE p_badge_type
    WHEN 'bronze'   THEN v_bronze
    WHEN 'silver'   THEN v_silver
    WHEN 'gold'     THEN v_gold
    WHEN 'platinum' THEN 5000
    WHEN 'elite'    THEN 12000
    WHEN 'legend'   THEN 25000
    ELSE 0
  END;

  SELECT array_position(v_tier_order, vc_badge) INTO v_current_idx
  FROM public.users WHERE id = v_uid;

  v_new_idx := array_position(v_tier_order, p_badge_type);

  IF v_current_idx IS NOT NULL AND v_new_idx < v_current_idx THEN
    RAISE EXCEPTION 'Cannot downgrade badge';
  END IF;

  PERFORM public._vc_deduct(v_uid, v_cost, 'Badge: ' || p_badge_type);

  UPDATE public.users SET vc_badge = p_badge_type WHERE id = v_uid;

  INSERT INTO public.vc_bonuses (user_id, bonus_type) VALUES (v_uid, 'badge_' || p_badge_type)
  ON CONFLICT (user_id, bonus_type) DO UPDATE SET granted_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.purchase_badge(text) TO authenticated;

-- feature_in_people_vc -- was: hardcoded 150 VC / 3 days. Identical
-- otherwise to migrations/20260626164106_fix-feature-in-people-cost-150.sql.
CREATE OR REPLACE FUNCTION public.feature_in_people_vc()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cost integer;
  v_days integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT vc_feature_me_cost, vc_feature_me_duration_days INTO v_cost, v_days
  FROM public.app_config LIMIT 1;

  PERFORM public._vc_deduct(v_uid, v_cost, 'Featured in People (' || v_days || ' days)');

  UPDATE public.users
  SET vc_featured_until = GREATEST(COALESCE(vc_featured_until, now()), now()) + make_interval(days => v_days)
  WHERE id = v_uid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.feature_in_people_vc() TO authenticated;

-- boost_event_vc -- was: hardcoded 1000 VC / 3 days. Identical otherwise
-- to migrations/20260620221549_vc-prize-draw-badges-boost-rpcs.sql.
CREATE OR REPLACE FUNCTION public.boost_event_vc(p_event_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cost integer;
  v_days integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id AND organizer_id = v_uid) THEN
    RAISE EXCEPTION 'Event not found or not yours';
  END IF;

  SELECT vc_event_boost_cost, vc_event_boost_duration_days INTO v_cost, v_days
  FROM app_config LIMIT 1;

  PERFORM _vc_deduct(v_uid, v_cost, 'Event boost (' || v_days || ' days)');

  INSERT INTO vc_event_boosts (event_id, user_id, expires_at)
  VALUES (p_event_id, v_uid, now() + make_interval(days => v_days))
  ON CONFLICT (event_id, user_id) DO UPDATE
  SET expires_at = GREATEST(vc_event_boosts.expires_at, now()) + make_interval(days => v_days),
      boosted_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION public.boost_event_vc(uuid) TO authenticated;

-- ── 3. get_vc_config() -- the single, authoritative, client-safe read ─────
-- Exposes ONLY the Category A economy/config values this task classified,
-- read live from the exact same app_config columns the RPCs above now
-- read. Nothing else on app_config (maintenance_mode, disable_* flags,
-- broadcast_message, min_client_version, the two dead redemption columns)
-- is exposed here -- this is deliberately a narrow, purpose-built read,
-- not a mirror of the whole table. No other user's data, no balances, no
-- admin-only config.
CREATE OR REPLACE FUNCTION public.get_vc_config()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT jsonb_build_object(
    'profile_completion_reward', vc_profile_completion_reward,
    'ticket_purchase_reward', vc_ticket_purchase_reward,
    'referral_referred_reward', vc_referral_referred_reward,
    'referral_referrer_reward', vc_referral_referrer_reward,
    'referral_referrer_hold_days', vc_referral_referrer_hold_days,
    'badge_bronze_price', vc_badge_bronze_price,
    'badge_silver_price', vc_badge_silver_price,
    'badge_gold_price', vc_badge_gold_price,
    'feature_me_cost', vc_feature_me_cost,
    'feature_me_duration_days', vc_feature_me_duration_days,
    'event_boost_cost', vc_event_boost_cost,
    'event_boost_duration_days', vc_event_boost_duration_days,
    -- The REAL cash-out rate/limits (Batch A/D, unchanged) -- this is the
    -- only rate that ever governs an actual VC -> NGN cash-out payout.
    'cashout_rate_naira_per_1000', vc_cashout_naira_per_1000,
    'cashout_min_vc', vc_cashout_min_vc,
    'cashout_max_vc', vc_cashout_max_vc,
    'cashout_daily_max_vc', vc_cashout_daily_max_vc,
    'cashout_daily_max_requests', vc_cashout_daily_max_requests,
    'cashout_cooldown_minutes', vc_cashout_cooldown_minutes,
    'cashout_maturation_hold_hours', vc_cashout_maturation_hold_hours,
    -- Objective 2: the SAME vc_naira_per_1000 value ReferralScreen.tsx
    -- already reads for its display-only "≈ ₦X in ticket credit" estimate
    -- -- named and positioned distinctly from cashout_rate_naira_per_1000
    -- above so no future consumer (frontend or AI) can confuse this
    -- display estimate with the real, authoritative cash-out rate. This
    -- is NOT wired to any redemption RPC and never has been.
    'ticket_credit_display_estimate_rate', vc_naira_per_1000
    -- vc_min_ticket_price / vc_max_redemption_pct deliberately NOT
    -- included -- dead columns for a feature that does not exist (see
    -- this migration's header comment and the COMMENT ON COLUMN above).
  )
  FROM public.app_config LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_vc_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vc_config() TO anon, authenticated;
