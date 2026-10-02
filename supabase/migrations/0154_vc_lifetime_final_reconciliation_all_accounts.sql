-- VENTS Cents -- FINAL Lifetime VC reconciliation (supersedes migration 0150).
--
-- AUTHORITATIVE RULE (explicit product decision, overriding the prior
-- exclusion of admin/sub-admin/house in 0150): every existing account's
-- current spendable VC balance must be reflected in its Lifetime VC,
-- regardless of role, with no cap. For each account:
--   new_lifetime_vc = GREATEST(existing_lifetime_vc, current_spendable_vc)
-- Lifetime VC is never reduced below its existing value.
--
-- This INCLUDES the VENTS house/admin account (c9eb5eb6, username "vents",
-- spendable 99,999,350 at the time of this migration) and both sub-admin
-- accounts. The house account's balance is known pre-architecture
-- manual/test data (confirmed in an earlier audit this session), not
-- VC earned through any approved campaign -- product decision is to apply
-- the authoritative rule uniformly anyway, making it the highest-tier/
-- multiplier account in the system. This is intentional and documented
-- here, not an oversight.
--
-- This is a ONE-TIME reconciliation of EXISTING accounts only:
--   - new users still start at vc_lifetime_earned = 0 (unaffected: the
--     users table's default is unchanged by this migration)
--   - future campaign-earned VC still only counts toward lifetime when
--     vc_reward_campaigns.counts_toward_lifetime = true (award_vc_reward,
--     unchanged by this migration)
--   - future admin credits still only count toward lifetime when the
--     caller explicitly passes p_counts_toward_lifetime = true to the
--     5-arg admin_credit_vents_cents(...) overload (unchanged)
--   - spending VC, and VC->Wallet conversion, already never touch
--     vc_lifetime_earned anywhere in the codebase (confirmed by reading
--     every writer of vc_lifetime_earned: award_vc_reward,
--     admin_credit_vents_cents, and this migration -- no spend/convert
--     path writes to it)
--   - tier/multiplier remain derived solely from vc_tier_for_lifetime(),
--     the single authoritative function -- no second tier system
--
-- This migration touches ONLY users.vc_lifetime_earned and users.vc_badge
-- for the affected accounts. It does not move any VC: vents_wallets
-- balances, vc_transactions, vc_system_pool, and vc_pool_ledger are
-- completely untouched, so the 1,000,000,000 VC authoritative supply and
-- the pool/outstanding invariant are unaffected by construction (lifetime
-- is a running high-water-mark counter, not a balance).
--
-- Idempotency: vc_lifetime_final_reconciliation_log is a one-time audit
-- trail; this migration is a no-op if it has already run (checked via the
-- table's existence + a row count guard), so it cannot be accidentally
-- re-applied with a different spendable snapshot on a later deploy.

CREATE TABLE IF NOT EXISTS public.vc_lifetime_final_reconciliation_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id),
  username           text,
  role               text,
  spendable_before   integer NOT NULL,
  lifetime_before     integer NOT NULL,
  lifetime_after      integer NOT NULL,
  resulting_tier     text,
  resulting_multiplier numeric,
  created_at         timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  v_already_run boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.vc_lifetime_final_reconciliation_log) INTO v_already_run;
  IF v_already_run THEN
    RAISE NOTICE 'vc_lifetime_final_reconciliation_log already has rows -- this migration has already run, skipping.';
    RETURN;
  END IF;

  -- Snapshot every account whose spendable VC exceeds its current
  -- lifetime VC -- these are exactly the accounts this migration changes.
  INSERT INTO public.vc_lifetime_final_reconciliation_log
    (user_id, username, role, spendable_before, lifetime_before, lifetime_after, resulting_tier, resulting_multiplier)
  SELECT
    u.id,
    u.username,
    u.role,
    COALESCE(w.balance, 0)              AS spendable_before,
    u.vc_lifetime_earned                AS lifetime_before,
    GREATEST(u.vc_lifetime_earned, COALESCE(w.balance, 0)) AS lifetime_after,
    public.vc_tier_for_lifetime(GREATEST(u.vc_lifetime_earned, COALESCE(w.balance, 0))) AS resulting_tier,
    public.vc_multiplier_for_tier(public.vc_tier_for_lifetime(GREATEST(u.vc_lifetime_earned, COALESCE(w.balance, 0)))) AS resulting_multiplier
  FROM public.users u
  LEFT JOIN public.vents_wallets w ON w.user_id = u.id
  WHERE COALESCE(w.balance, 0) > u.vc_lifetime_earned;

  -- Apply: bump vc_lifetime_earned to the high-water mark and resync
  -- vc_badge from the single authoritative tier function. Never lowers
  -- vc_lifetime_earned (GREATEST), never touches spendable balances.
  UPDATE public.users u
  SET vc_lifetime_earned = log.lifetime_after,
      vc_badge = log.resulting_tier
  FROM public.vc_lifetime_final_reconciliation_log log
  WHERE u.id = log.user_id;
END $$;
