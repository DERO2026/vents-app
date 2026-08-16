-- Fix: Supabase grants broad default privileges (INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER/SELECT) to anon and authenticated on every
-- new table in public automatically at CREATE TABLE time — a platform
-- default, not something 0011_grants.sql requested. Discovered during
-- post-apply verification: anon/authenticated had TRUNCATE on tickets,
-- pending_purchases, and organizer_bank_accounts (TRUNCATE bypasses RLS
-- entirely — this would have let any client wipe those tables outright,
-- a severe regression from InsForge's actual posture). This migration
-- revokes everything from anon/authenticated/PUBLIC on every table, then
-- 0011_grants.sql's exact GRANTs (already applied, safe to restate) are
-- the only privileges that remain — matching InsForge exactly, table by
-- table, with nothing left over from the platform default.

REVOKE ALL ON public.admin_action_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.admin_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.app_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.blocked_users FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.checkins FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.conversation_clears FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.conversation_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.deleted_emails FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.deleted_phones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.device_fingerprints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.device_push_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.direct_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.event_promotions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.event_reminder_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.highlights FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.media_assets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.message_reactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.notifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_bank_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_reviews FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_transactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_verification_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_wallets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organizer_withdrawal_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.pending_purchases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.promo_codes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.rate_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referrals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.referred_emails FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.saved_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.scan_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.search_synonyms FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.tickets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.user_privacy_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.users FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vc_bonuses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vc_event_boosts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vc_transactions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.vents_wallets FROM PUBLIC, anon, authenticated;

-- Re-affirm the exact anon/authenticated grants InsForge actually has (same statements 0011 already applied; restating is idempotent and confirms nothing beyond these remains).
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_action_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_action_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_logs TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_logs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.app_config TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.app_config TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.blocked_users TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.blocked_users TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.checkins TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.checkins TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_clears TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_clears TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.deleted_emails TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.deleted_emails TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_fingerprints TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_fingerprints TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_push_tokens TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_push_tokens TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.direct_messages TO anon;
GRANT DELETE, SELECT, UPDATE ON public.direct_messages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_promotions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_promotions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_reminder_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_reminder_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.highlights TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.highlights TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.media_assets TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.media_assets TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.message_reactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.message_reactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO authenticated;
GRANT SELECT ON public.organizer_bank_accounts TO anon;
GRANT SELECT ON public.organizer_bank_accounts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_reviews TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_reviews TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_transactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_transactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_verification_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_verification_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_wallets TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_wallets TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_withdrawal_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_withdrawal_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.promo_codes TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.promo_codes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.public_profiles TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.public_profiles TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rate_limits TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rate_limits TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referrals TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referrals TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referred_emails TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referred_emails TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reports TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reports TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.saved_events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.saved_events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.scan_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.scan_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.search_synonyms TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.search_synonyms TO authenticated;
GRANT SELECT ON public.tickets TO anon;
GRANT SELECT ON public.tickets TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_privacy_settings TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_privacy_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_bonuses TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_bonuses TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_event_boosts TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_event_boosts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_transactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_transactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vents_wallets TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vents_wallets TO authenticated;
