-- VENTS Cents: one-time Lifetime VC grandfather for existing legitimate
-- customer accounts, per explicit product decision.
--
-- Rule (idempotent by construction): new_lifetime = GREATEST(existing
-- vc_lifetime_earned, current spendable vc_transactions balance). Never
-- lowers an existing Lifetime VC value, never touches spendable balance,
-- never touches vc_transactions history, never touches the 1,000,000,000 VC
-- supply or the system pool (this moves no VC -- it only reconciles a
-- bookkeeping column against VC that already legitimately exists in the
-- user's wallet).
--
-- Explicitly excluded, by role and by individually identified account (not
-- a blanket pattern-match, since the whole point is precision):
--   - admin:     c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832 (the VENTS house
--                account -- its ~100M VC balance predates all current
--                accounting and is explicitly never to be converted into
--                qualifying Lifetime VC).
--   - sub-admin: dfca505f-b2f6-449f-aa86-f7e7ece7d1dc (ventsofficial),
--                a4402494-d7a0-4537-a83c-362fe71ec44f.
--   - identified test accounts (by username/email pattern, individually
--     confirmed, not inferred): 91b0afb4-b5dc-4289-ae00-8e6e58c60f5f
--     (username "testerboy"), 857d7606-f866-4895-864a-a39ea38b2aa3
--     (username "testerboy2"), 7af13434-47ce-4032-93df-2fb271b05e18
--     (username "vt_test_a_zk9x4", email a "+"-tagged alias of the
--     project's own operator email -- a self-evidently test-created
--     account).
--
-- Included (ordinary customer accounts, role = 'user', no test markers,
-- real account history): fc45414e-6aef-494f-bbb4-b373dac5196b (dero),
-- 838beb9c-5ec6-455b-9420-295b8007358e, 711b8a48-f06d-479f-9191-2fb33c76f291,
-- 00a75bc6-097a-40a6-96d5-966fdc54dc1f. Note: fc45414e's spendable balance
-- (398,700 VC) is well above the Legend threshold (30,000) -- grandfathering
-- it raises that account to Legend tier and immediate Gold+ conversion
-- eligibility for its full balance. This is a direct, expected consequence
-- of the approved formula, not a bug; flagged here for visibility.
--
-- Tier/multiplier are NOT touched by this migration -- they are never
-- stored directly, only derived live from vc_lifetime_earned by the
-- existing, unchanged vc_tier_for_lifetime()/vc_multiplier_for_tier()/
-- vc_tier_and_multiplier_for_user() functions. Raising vc_lifetime_earned
-- here is sufficient for every caller of those functions (frontend and
-- admin console alike) to immediately reflect the correct tier/multiplier.

CREATE TABLE IF NOT EXISTS public.vc_lifetime_grandfather_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  old_lifetime_vc integer NOT NULL,
  spendable_vc_used integer NOT NULL,
  new_lifetime_vc integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE public.vc_lifetime_grandfather_log ENABLE ROW LEVEL SECURITY;
-- No client-facing policies -- this is an internal audit trail, readable
-- only via the privileged connection/admin tooling, same posture as
-- vc_pool_ledger.

DO $$
DECLARE
  v_user record;
  v_spendable integer;
  v_old_lifetime integer;
  v_new_lifetime integer;
  v_included_ids uuid[] := ARRAY[
    'fc45414e-6aef-494f-bbb4-b373dac5196b',
    '838beb9c-5ec6-455b-9420-295b8007358e',
    '711b8a48-f06d-479f-9191-2fb33c76f291',
    '00a75bc6-097a-40a6-96d5-966fdc54dc1f'
  ]::uuid[];
BEGIN
  FOR v_user IN
    SELECT u.id, u.vc_lifetime_earned, COALESCE(w.balance, 0) AS spendable
    FROM public.users u
    LEFT JOIN public.vents_wallets w ON w.user_id = u.id
    WHERE u.id = ANY(v_included_ids)
    FOR UPDATE OF u
  LOOP
    v_old_lifetime := v_user.vc_lifetime_earned;
    v_spendable := v_user.spendable;
    v_new_lifetime := GREATEST(v_old_lifetime, v_spendable);

    UPDATE public.users SET vc_lifetime_earned = v_new_lifetime WHERE id = v_user.id;

    INSERT INTO public.vc_lifetime_grandfather_log
      (user_id, old_lifetime_vc, spendable_vc_used, new_lifetime_vc, reason)
    VALUES (
      v_user.id, v_old_lifetime, v_spendable, v_new_lifetime,
      'One-time grandfather of pre-existing legitimate spendable VC into Lifetime VC (migration 0150): new_lifetime = GREATEST(old_lifetime, spendable_at_migration_time)'
    )
    ON CONFLICT (user_id) DO NOTHING;
  END LOOP;
END $$;
