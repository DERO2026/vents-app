-- Task 4: Performance indexes (issues 54-75) and email_otps autovacuum tuning (issue 100).

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
-- tickets has no organizer_id column; skipped
CREATE INDEX IF NOT EXISTS idx_events_hidden_by ON public.events(hidden_by);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON public.follows(following_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_target_user_id ON public.admin_logs(target_user_id);
-- checkins has no organizer_id or user_id columns; skipped those two
CREATE INDEX IF NOT EXISTS idx_checkins_scanned_by ON public.checkins(scanned_by);
CREATE INDEX IF NOT EXISTS idx_direct_messages_event_id ON public.direct_messages(event_id);
CREATE INDEX IF NOT EXISTS idx_referred_emails_referrer_id ON public.referred_emails(referrer_id);
CREATE INDEX IF NOT EXISTS idx_prize_draw_winners_user_id ON public.prize_draw_winners(user_id);
CREATE INDEX IF NOT EXISTS idx_vc_event_boosts_user_id ON public.vc_event_boosts(user_id);
CREATE INDEX IF NOT EXISTS idx_organizer_withdrawal_requests_bank_account_id ON public.organizer_withdrawal_requests(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_app_config_updated_by ON public.app_config(updated_by);

-- email_otps autovacuum tuning (issue 100): table lives in auth schema (system-managed),
-- not accessible via migration. Skipped — InsForge manages autovacuum on auth schema tables.
