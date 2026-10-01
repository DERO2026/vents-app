-- RECONSTRUCTION FILE -- this migration documents DDL that was already
-- applied directly to production (project slrtjxtzhowhwhebjprv) via the
-- Supabase MCP apply_migration tool, under the live migration name
-- `vc_lifetime_earned_badge_tier_ledger_foundation` (recorded in
-- supabase_migrations.schema_migrations with version 20261001085426). This
-- file exists only to bring the repo back in sync with that live change —
-- it is NOT a new change and must NOT be re-run against production as a
-- fresh migration, since every statement here is already present live and
-- is written idempotently (IF NOT EXISTS / OR REPLACE / ON CONFLICT DO
-- NOTHING) specifically so it is a safe no-op if it is ever re-applied, and
-- so it is reproducible from scratch on a fresh database/branch.
--
-- Batch A of the approved VC economy refactor ("Ledger Foundation" only):
-- lifetime qualifying VC earned tracking, badge tier/multiplier lookup,
-- and multiplier support in award_vc_reward() -- with NO behavior change
-- yet. Per the approved scope: no check-in/referral activation, no
-- cash-out changes, no frontend changes, no reassignment of existing
-- purchased badges. See the Batch A product-decision message (2026-10-01)
-- for the full spec this implements.
--
-- IMPORTANT / FLAGGED FOR PRODUCT REVIEW: the vc_badge_tiers thresholds
-- seeded below (300 / 800 / 2,000 / 5,000 / 12,000 / 25,000) are PLACEHOLDER
-- values carried over verbatim from the old purchase_badge() price ladder.
-- They were never approved as the new lifetime-earned thresholds and must
-- not be treated as final. Only the tier names and multipliers
-- (bronze 1.0x / silver 1.1x / gold 1.25x / platinum 1.5x / elite 2.0x /
-- legend 3.0x) were explicitly approved.

-- 1. Lifetime qualifying VC earned counter on users, tamper-resistant via
--    the existing protect_trust_signal_columns() trigger (reused, not a
--    new trigger).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS vc_lifetime_earned integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'vc_lifetime_earned_non_negative'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT vc_lifetime_earned_non_negative CHECK (vc_lifetime_earned >= 0);
  END IF;
END $$;

-- 2. Extend the existing trust-signal protection trigger function to also
--    block direct client writes to vc_lifetime_earned. Reuses the same
--    trigger (trg_protect_trust_signal_columns) already on public.users --
--    no new trigger needed.
CREATE OR REPLACE FUNCTION public.protect_trust_signal_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_verified IS DISTINCT FROM NEW.is_verified THEN
    RAISE EXCEPTION 'is_verified can only be changed via organizer verification approval';
  END IF;
  IF OLD.vc_badge IS DISTINCT FROM NEW.vc_badge THEN
    RAISE EXCEPTION 'vc_badge can only be changed via purchase_badge()';
  END IF;
  IF OLD.vc_featured_until IS DISTINCT FROM NEW.vc_featured_until THEN
    RAISE EXCEPTION 'vc_featured_until can only be changed via feature_in_people_vc()';
  END IF;
  IF OLD.vc_lifetime_earned IS DISTINCT FROM NEW.vc_lifetime_earned THEN
    RAISE EXCEPTION 'vc_lifetime_earned can only be changed via award_vc_reward()';
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Badge tier/multiplier reference table. Admin-editable thresholds so
--    the placeholder values below can be corrected without a further
--    migration once the real thresholds are approved.
CREATE TABLE IF NOT EXISTS public.vc_badge_tiers (
  tier text PRIMARY KEY,
  rank integer NOT NULL UNIQUE,
  min_lifetime_vc integer NOT NULL CHECK (min_lifetime_vc >= 0),
  multiplier numeric(4,2) NOT NULL CHECK (multiplier > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.vc_badge_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vc_badge_tiers_select_all ON public.vc_badge_tiers;
CREATE POLICY vc_badge_tiers_select_all ON public.vc_badge_tiers
  FOR SELECT USING (true);

REVOKE ALL ON public.vc_badge_tiers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vc_badge_tiers TO anon, authenticated;

-- PLACEHOLDER thresholds -- see header note. Multipliers are the approved
-- values; min_lifetime_vc is carried over from the old purchase price
-- ladder only as a placeholder pending product approval.
INSERT INTO public.vc_badge_tiers (tier, rank, min_lifetime_vc, multiplier) VALUES
  ('bronze',   1, 300,    1.00),
  ('silver',   2, 800,    1.10),
  ('gold',     3, 2000,   1.25),
  ('platinum', 4, 5000,   1.50),
  ('elite',    5, 12000,  2.00),
  ('legend',   6, 25000,  3.00)
ON CONFLICT (tier) DO NOTHING;

-- 4. Tier/multiplier lookup functions.
CREATE OR REPLACE FUNCTION public.vc_tier_for_lifetime(p_lifetime integer)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT t.tier
  FROM public.vc_badge_tiers t
  WHERE t.min_lifetime_vc <= COALESCE(p_lifetime, 0)
  ORDER BY t.rank DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.vc_multiplier_for_tier(p_tier text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT t.multiplier FROM public.vc_badge_tiers t WHERE t.tier = p_tier), 1.0);
$function$;

CREATE OR REPLACE FUNCTION public.vc_tier_and_multiplier_for_user(p_user_id uuid)
 RETURNS TABLE(lifetime_earned integer, tier text, multiplier numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_lifetime integer;
  v_tier text;
BEGIN
  SELECT u.vc_lifetime_earned INTO v_lifetime FROM public.users u WHERE u.id = p_user_id;
  IF v_lifetime IS NULL THEN
    RETURN QUERY SELECT 0, NULL::text, 1.0::numeric;
    RETURN;
  END IF;
  v_tier := public.vc_tier_for_lifetime(v_lifetime);
  RETURN QUERY SELECT v_lifetime, v_tier, public.vc_multiplier_for_tier(v_tier);
END;
$function$;

REVOKE ALL ON FUNCTION public.vc_tier_for_lifetime(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vc_tier_for_lifetime(integer) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.vc_multiplier_for_tier(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vc_multiplier_for_tier(text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.vc_tier_and_multiplier_for_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vc_tier_and_multiplier_for_user(uuid) TO authenticated, project_admin;

-- 5. Campaign-level flags: which campaigns count toward lifetime earned,
--    and which are eligible for the badge-tier multiplier. Both default
--    false so every existing enabled campaign is completely unaffected
--    until explicitly flagged below.
ALTER TABLE public.vc_reward_campaigns
  ADD COLUMN IF NOT EXISTS counts_toward_lifetime boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS multiplier_eligible boolean NOT NULL DEFAULT false;

-- Per the approved Batch A spec, qualifying earned rewards are: profile
-- completion, event check-in, referred-user signup, and the referrer's
-- successful-first-check-in reward. ticket_purchase, first_ticket_purchase,
-- and the existing time-held referral_referrer reward are explicitly
-- excluded (not qualifying per the spec).
UPDATE public.vc_reward_campaigns
  SET counts_toward_lifetime = true
  WHERE key IN ('profile_complete', 'referral_referred');

-- event_checkin and referral_referrer_checkin are the two NEW qualifying
-- campaigns required by the spec (check-in reward, referral first-check-in
-- reward). Inserted INERT (enabled = false) -- Batch A activates no new
-- reward behavior. Multiplier-eligible since both are qualifying earn
-- events under the new tier system.
INSERT INTO public.vc_reward_campaigns (key, label, amount_vc, enabled, counts_toward_lifetime, multiplier_eligible)
VALUES
  ('event_checkin', 'Event check-in', 250, false, true, true),
  ('referral_referrer_checkin', E'Referral -- friend''s first check-in', 1000, false, true, true)
ON CONFLICT (key) DO NOTHING;

-- 6. award_vc_reward(): adds badge-tier multiplier support (applied only
--    when the campaign is multiplier_eligible) and increments
--    vc_lifetime_earned only when the campaign counts_toward_lifetime.
--    Every previously existing validation/idempotency/cap behavior is
--    unchanged; the only behavioral delta for any EXISTING enabled
--    campaign is the new lifetime-earned bookkeeping for profile_complete
--    and referral_referred (both multiplier_eligible = false, so their
--    awarded VC amount is unchanged).
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

  UPDATE public.vc_reward_campaigns SET total_awarded = total_awarded + 1 WHERE key = p_campaign_key;

  IF v_campaign.counts_toward_lifetime THEN
    UPDATE public.users SET vc_lifetime_earned = vc_lifetime_earned + v_amount WHERE id = p_user_id;
  END IF;

  RETURN jsonb_build_object('awarded', true, 'amount', v_amount, 'transaction_id', v_tx_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('awarded', false, 'reason', 'already_awarded');
END;
$function$;

REVOKE ALL ON FUNCTION public.award_vc_reward(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.award_vc_reward(uuid, text, uuid, text) TO postgres, project_admin;
