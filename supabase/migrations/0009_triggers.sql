-- Triggers (32), verbatim from the live InsForge database. Must run after
-- 0004 (functions) since every CREATE TRIGGER references a function that
-- must already exist — the raw export lists triggers BEFORE functions,
-- which would fail if applied in that order.

CREATE TRIGGER trg_door_checkin AFTER INSERT ON checkins FOR EACH ROW EXECUTE FUNCTION notify_door_checkin();
CREATE TRIGGER trg_realtime_new_dm AFTER INSERT ON direct_messages FOR EACH ROW EXECUTE FUNCTION notify_new_direct_message();
CREATE TRIGGER trg_event_payout_account BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_event_payout_account();
CREATE TRIGGER trg_events_notify_update AFTER UPDATE ON events FOR EACH ROW EXECUTE FUNCTION notify_event_update();
CREATE TRIGGER trg_organizer_events_event AFTER INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION notify_organizer_events_event();
CREATE TRIGGER trg_protect_event_promotion_columns BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION protect_event_promotion_columns();
CREATE TRIGGER trg_validate_events_input BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION validate_events_input();
CREATE TRIGGER validate_event_ticket_types_trigger BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION validate_event_ticket_types();
CREATE TRIGGER trg_realtime_new_notification AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION notify_new_notification();
CREATE TRIGGER trg_realtime_admin_stats_transaction AFTER INSERT ON organizer_transactions FOR EACH ROW EXECUTE FUNCTION notify_admin_stats_transaction();
CREATE TRIGGER trg_realtime_admin_stats_payout AFTER INSERT OR UPDATE ON organizer_withdrawal_requests FOR EACH ROW EXECUTE FUNCTION notify_admin_stats_payout();
CREATE TRIGGER trg_referral_pending_until BEFORE INSERT ON referrals FOR EACH ROW EXECUTE FUNCTION set_referral_pending_until();
CREATE TRIGGER trg_door_scan AFTER INSERT ON scan_log FOR EACH ROW EXECUTE FUNCTION notify_door_scan();
CREATE TRIGGER trg_door_ticket AFTER INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION notify_door_ticket();
CREATE TRIGGER trg_organizer_events_ticket AFTER INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION notify_organizer_events_ticket();
CREATE TRIGGER trg_check_user_role_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION check_user_role_update();
CREATE TRIGGER trg_lock_admin_root_role BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION lock_admin_root_role();
CREATE TRIGGER trg_protect_admin_tier_status_columns BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_admin_tier_status_columns();
CREATE TRIGGER trg_protect_trust_signal_columns BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_trust_signal_columns();
CREATE TRIGGER trg_realtime_admin_stats_signup AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION notify_admin_stats_signup();
CREATE TRIGGER trg_validate_users_input BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION validate_users_input();
CREATE TRIGGER trg_realtime_vc AFTER INSERT OR UPDATE ON vc_transactions FOR EACH ROW EXECUTE FUNCTION notify_vc_update();
CREATE TRIGGER trg_vc_wallet_sync AFTER INSERT ON vc_transactions FOR EACH ROW EXECUTE FUNCTION trg_sync_vc_to_wallet();

-- on_auth_user_created — lives on auth.users, not any public table, so it
-- was outside the scope of the (public-schema-only) InsForge export and had
-- to be added by hand. This is the trigger that provisions the matching
-- public.users profile row on every signup — without it, signups on
-- Supabase would silently never create a profile. Confirmed against the
-- live InsForge database's actual pg_get_triggerdef() output, and matches
-- Supabase's own documented pattern for this exact use case.
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
