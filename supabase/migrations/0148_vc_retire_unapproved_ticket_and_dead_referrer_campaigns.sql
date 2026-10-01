-- VENTS Cents reconciliation: retire two campaigns that are live/reachable
-- but were never part of the approved earning rules, plus one genuinely
-- dead legacy campaign.
--
-- Config-only change: disables rows in vc_reward_campaigns. Does not touch
-- confirm_ticket_payment(), confirm_ticket_payment_via_wallet(), or any
-- other function body -- award_vc_reward() already returns
-- {awarded:false, reason:'campaign_disabled'} for a disabled campaign
-- before it ever inserts a vc_transactions row or touches the system pool,
-- so disabling here is sufficient to stop both call sites from ever
-- awarding VC through either campaign, with zero code changes needed.
-- Ticket payment confirmation, issuance, wallet payment, and notifications
-- are all untouched -- they only ever PERFORM award_vc_reward(...) and
-- ignore its return value.
--
-- Pre-migration verification (read-only, see chat record): both
-- ticket_purchase and first_ticket_purchase have total_awarded = 0 and
-- zero matching vc_transactions rows in production, so there is nothing to
-- reverse on the user side and no pool adjustment is needed. No historical
-- vc_transactions row is modified by this migration.
--
-- referral_referrer (300 VC) was superseded by referral_referrer_checkin
-- (1,000 VC x multiplier, Batch C) and has had zero call sites in the
-- codebase since that redesign -- confirmed by grep across every
-- migration. Disabling it is pure configuration cleanup with no
-- behavioral effect, since nothing has ever called it.
--
-- The four approved campaigns (profile_complete, referral_referred,
-- event_checkin, referral_referrer_checkin) are untouched.

UPDATE public.vc_reward_campaigns
   SET enabled = false, updated_at = now()
 WHERE key IN ('ticket_purchase', 'first_ticket_purchase', 'referral_referrer')
   AND enabled = true;
