-- Batch C: activate the referral_referrer_checkin campaign now that the
-- referred-user reward redesign (0142) and the referrer check-in wiring
-- (0143) are fully live-verified. Confirmed unchanged from Batch A:
-- amount_vc=1000, counts_toward_lifetime=true, multiplier_eligible=true --
-- this migration only flips `enabled`.
--
-- Already applied live to production (project slrtjxtzhowhwhebjprv) via
-- the Supabase MCP apply_migration tool, under the live migration name
-- `vc_referral_referrer_checkin_activation`.
UPDATE public.vc_reward_campaigns SET enabled = true WHERE key = 'referral_referrer_checkin';
