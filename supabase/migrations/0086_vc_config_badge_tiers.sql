-- ============================================================================
-- VENTS Cents Batch F2 -- extend get_vc_config() with platinum/elite/legend
-- badge prices.
--
-- Batch F1 (0085) moved bronze/silver/gold badge prices into app_config and
-- exposed them via get_vc_config(), but deliberately left platinum/elite/
-- legend hardcoded inside purchase_badge()'s SQL body (5000/12000/25000),
-- per F1's own explicit, narrowly-scoped brief. Those three tiers are real
-- and reachable (purchase_badge() accepts all six values, backed by a real
-- CHECK constraint -- see 0085's header note), so Batch F2's UI needs
-- authoritative numbers for all six tiers, not just three.
--
-- Reasoning for the approach taken here (documented per this task's
-- instruction to explain the choice): rather than adding three more
-- app_config columns and re-pointing purchase_badge() at them (which would
-- touch purchase_badge() -- explicitly out of scope for this batch, per the
-- task brief: "Do NOT touch purchase_badge() itself or change any badge
-- price"), this migration ONLY adds the three tiers' prices as additional
-- jsonb fields on get_vc_config()'s return value, hardcoded ONCE here with
-- a clear comment that they mirror purchase_badge()'s existing literals.
-- This keeps the change purely additive to a read-only, client-safe RPC,
-- touches no other function, changes no grant/RLS, and gives the frontend
-- and AI tooling one real source for all 6 badge prices. A future batch can
-- migrate these three into app_config columns and re-point purchase_badge()
-- at them (matching F1's treatment of bronze/silver/gold) without changing
-- get_vc_config()'s external shape at all.
--
-- purchase_badge() itself is NOT redefined by this migration -- its
-- literals (5000/12000/25000) remain exactly as 0085 left them, and this
-- migration's own literals below must be kept in sync with them by hand
-- until that future migration exists.
-- ============================================================================

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
    -- Batch F2 addition: mirrors purchase_badge()'s own hardcoded literals
    -- exactly (5000 / 12000 / 25000, unchanged by this migration). Not read
    -- from app_config -- see this migration's header for why.
    'badge_platinum_price', 5000,
    'badge_elite_price', 12000,
    'badge_legend_price', 25000,
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
    -- Objective 2 (Batch F1): the SAME vc_naira_per_1000 value
    -- ReferralScreen.tsx already reads for its display-only "≈ ₦X in ticket
    -- credit" estimate -- named and positioned distinctly from
    -- cashout_rate_naira_per_1000 above so no future consumer (frontend or
    -- AI) can confuse this display estimate with the real, authoritative
    -- cash-out rate. This is NOT wired to any redemption RPC and never has
    -- been.
    'ticket_credit_display_estimate_rate', vc_naira_per_1000
    -- vc_min_ticket_price / vc_max_redemption_pct deliberately NOT
    -- included -- dead columns for a feature that does not exist (see
    -- 0085's header comment and its COMMENT ON COLUMN statements).
  )
  FROM public.app_config LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_vc_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_vc_config() TO anon, authenticated;
