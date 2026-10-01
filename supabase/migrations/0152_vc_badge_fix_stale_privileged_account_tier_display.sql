-- VENTS Cents: fix stale tier-display state on privileged accounts.
--
-- Migration 0150 correctly excluded admin/sub-admin accounts from the
-- Lifetime VC grandfather (their authoritative vc_lifetime_earned remains
-- 0, as required). But their users.vc_badge column still held a stale
-- value from the retired purchase_badge() era, predating the current
-- lifetime-based tier system -- so a screen reading vc_badge directly
-- (ProfileScreen, UserProfileScreen, HomeScreen, ExploreScreen,
-- ConversationScreen) would show these accounts as Legend/Elite/Bronze
-- despite zero qualifying Lifetime VC.
--
-- Read-only check performed before this migration (see chat record):
--   id                                   | role      | lifetime | old vc_badge | authoritative tier
--   c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832 | admin     | 0        | legend       | NULL
--   a4402494-d7a0-4537-a83c-362fe71ec44f | sub-admin | 0        | bronze       | NULL
--   dfca505f-b2f6-449f-aa86-f7e7ece7d1dc | sub-admin | 0        | elite        | NULL
--
-- Uses the existing, unchanged vc_tier_for_lifetime() function -- no new
-- tier calculation. Touches only users.vc_badge, only on these three
-- specific accounts. Does not touch vc_lifetime_earned, vents_wallets,
-- vc_system_pool, the 1,000,000,000 supply, role/privileges, conversion
-- logic, the house account's balance, or any customer's Lifetime VC.
UPDATE public.users
   SET vc_badge = public.vc_tier_for_lifetime(vc_lifetime_earned)
 WHERE id IN (
   'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', -- admin (house account)
   'a4402494-d7a0-4537-a83c-362fe71ec44f', -- sub-admin
   'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc'  -- sub-admin (ventsofficial)
 );
