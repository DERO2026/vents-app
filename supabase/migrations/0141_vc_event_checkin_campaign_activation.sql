-- Batch B: activate the event_checkin campaign now that the award is wired
-- into verify_entry_pass/manual_check_in (0140) and fully live-verified.
-- Confirmed unchanged from Batch A: amount_vc=250, counts_toward_lifetime
-- =true, multiplier_eligible=true -- this migration only flips `enabled`.
-- referral_referrer_checkin remains disabled -- out of scope for this batch.
--
-- Already applied live to production (project slrtjxtzhowhwhebjprv) via
-- the Supabase MCP apply_migration tool, under the live migration name
-- `vc_event_checkin_campaign_activation`.
UPDATE public.vc_reward_campaigns SET enabled = true WHERE key = 'event_checkin';
