-- Batch A follow-up: replace the PLACEHOLDER vc_badge_tiers thresholds
-- seeded in 0138 (carried over from the old purchase-badge price ladder,
-- explicitly flagged there as unapproved) with the lifetime-qualifying-VC
-- thresholds approved for the new badge-tier system. Multipliers were
-- already approved in the original Batch A decision and are unchanged
-- here; this migration only updates min_lifetime_vc (re-stating the
-- multiplier on each row is redundant but harmless, kept for clarity and
-- to make this migration fully self-describing without cross-referencing
-- 0138).
--
-- Already applied live to production (project slrtjxtzhowhwhebjprv) via
-- the Supabase MCP apply_migration tool, under the live migration name
-- `vc_badge_tiers_approved_lifetime_thresholds`. This file mirrors that
-- change for the repo, per this project's established convention of
-- local sequentially-numbered files vs. a timestamped live migration
-- history (see 0138's header and the migration-reconciliation review
-- that preceded this file). Written as plain UPDATEs (not
-- INSERT ... ON CONFLICT DO NOTHING) since the target rows already exist
-- from 0138 and must be corrected in place, not left alone.
UPDATE public.vc_badge_tiers SET min_lifetime_vc = 500,   multiplier = 1.00 WHERE tier = 'bronze';
UPDATE public.vc_badge_tiers SET min_lifetime_vc = 1500,  multiplier = 1.10 WHERE tier = 'silver';
UPDATE public.vc_badge_tiers SET min_lifetime_vc = 4000,  multiplier = 1.25 WHERE tier = 'gold';
UPDATE public.vc_badge_tiers SET min_lifetime_vc = 8000,  multiplier = 1.50 WHERE tier = 'platinum';
UPDATE public.vc_badge_tiers SET min_lifetime_vc = 15000, multiplier = 2.00 WHERE tier = 'elite';
UPDATE public.vc_badge_tiers SET min_lifetime_vc = 30000, multiplier = 3.00 WHERE tier = 'legend';
