-- Function EXECUTE privileges, reconstructed from the live InsForge project's
-- actual current grants (information_schema / has_function_privilege), NOT
-- replayed from migration history, because InsForge migrations contain many
-- superseded GRANT/REVOKE pairs (a function locked down today may have been
-- opened to `authenticated` by an earlier, now-obsolete migration). This file
-- is the single source of truth for current-state privileges.

-- Start from a known-safe baseline: PUBLIC gets nothing on any function.
-- (Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION, so every
-- function must be explicitly locked down.)

REVOKE ALL ON FUNCTION public._vc_deduct(p_user_id uuid, p_amount integer, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public._vc_deduct(p_user_id uuid, p_amount integer, p_reason text) TO project_admin;

REVOKE ALL ON FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.actor_role() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.actor_role() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.add_bank_account_confirmed(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.add_bank_account_confirmed(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_approve_organizer_verification(p_request_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_approve_organizer_verification(p_request_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_broadcast(p_title text, p_body text, p_type text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_broadcast(p_title text, p_body text, p_type text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_get_new_user_stats() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_get_new_user_stats() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_get_vc_aggregates() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_get_vc_aggregates() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_get_verification_stats() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_get_verification_stats() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_health_ping() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_health_ping() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_hide_event(p_event_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_hide_event(p_event_id uuid, p_reason text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_action_requests(p_status text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_action_requests(p_status text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_organizer_verifications(p_status text, p_search text, p_limit integer, p_offset integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_organizer_verifications(p_status text, p_search text, p_limit integer, p_offset integer) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_pending_payouts() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_payouts() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_processing_payouts() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_processing_payouts() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_push_tokens(p_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_push_tokens(p_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_mark_all_requests_seen() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_mark_all_requests_seen() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_mark_request_seen(p_request_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_mark_request_seen(p_request_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_pending_request_count() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_pending_request_count() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_prune_push_token(p_token text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_prune_push_token(p_token text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_reinstate_event(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_event(p_event_id uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_reinstate_user(p_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_user(p_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_release_payout_claim(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_release_payout_claim(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_restore_deleted_event(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_restore_deleted_event(p_event_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_send_broadcast(p_title text, p_body text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_send_broadcast(p_title text, p_body text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_suspend_user(p_user_id uuid, p_banned_until timestamp with time zone, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_suspend_user(p_user_id uuid, p_banned_until timestamp with time zone, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_toggle_user_verified(p_user_id uuid, p_verified boolean, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_toggle_user_verified(p_user_id uuid, p_verified boolean, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_unsuspend_user(p_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_unsuspend_user(p_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.approve_admin_action(p_request_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.approve_admin_action(p_request_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.assert_recent_auth() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.assert_recent_auth() TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.block_user(p_blocked_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.block_user(p_blocked_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.boost_event_vc(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.boost_event_vc(p_event_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.check_and_clear_pending_vc() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.check_and_clear_pending_vc() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.check_auth_rate_limit(p_action text, p_identifier text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.check_auth_rate_limit(p_action text, p_identifier text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.check_signups_enabled() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.check_signups_enabled() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.check_user_exists(p_email text, p_phone text, p_username text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.check_user_exists(p_email text, p_phone text, p_username text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.check_user_role_update() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.check_user_role_update() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.claim_profile_bonus() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.claim_profile_bonus() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.cleanup_orphaned_records() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.cleanup_orphaned_records() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.clear_conversation(p_other_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.clear_conversation(p_other_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.client_ip() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.client_ip() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.complete_organizer_payout(p_request_id text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.complete_organizer_payout(p_request_id text) TO project_admin;

REVOKE ALL ON FUNCTION public.complete_referral(p_referrer_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.complete_referral(p_referrer_code text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint) TO project_admin;

REVOKE ALL ON FUNCTION public.create_pending_purchase(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_promo_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_promo_code text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.create_referral(p_invitee_email text, p_email_hash text, p_fingerprint text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.create_referral(p_invitee_email text, p_email_hash text, p_fingerprint text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.credit_organizer_wallet(p_organizer_id uuid, p_amount_kobo bigint, p_description text, p_ticket_sale_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.credit_organizer_wallet(p_organizer_id uuid, p_amount_kobo bigint, p_description text, p_ticket_sale_id uuid) TO project_admin;

REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.door_stats(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.door_stats(p_event_id uuid) TO project_admin;

REVOKE ALL ON FUNCTION public.email_exists(p_email text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.email_exists(p_email text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text) TO project_admin;

REVOKE ALL ON FUNCTION public.fail_ticket_refund(p_refund_id text, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.fail_ticket_refund(p_refund_id text, p_reason text) TO project_admin;

REVOKE ALL ON FUNCTION public.feature_in_people_vc() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.feature_in_people_vc() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.finalize_pending_purchase(p_payment_ref text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_pending_purchase(p_payment_ref text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.finalize_ticket_refund(p_refund_id text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_ticket_refund(p_refund_id text) TO project_admin;

REVOKE ALL ON FUNCTION public.generate_ticket_token(p_ticket_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.generate_ticket_token(p_ticket_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_account_status(p_email text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_account_status(p_email text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_door_stats(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_door_stats(p_event_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_event_attendees(p_event_id uuid, p_search text, p_filter text, p_limit integer, p_offset integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_attendees(p_event_id uuid, p_search text, p_filter text, p_limit integer, p_offset integer) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_event_ticket_stats(p_event_ids uuid[]) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_ticket_stats(p_event_ids uuid[]) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_event_ticket_type_availability(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_ticket_type_availability(p_event_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_event_trending_scores(p_event_ids uuid[]) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_trending_scores(p_event_ids uuid[]) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_my_vc_balance() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_my_vc_balance() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_organizer_events_overview() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_organizer_events_overview() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_pending_push_notifications(p_limit integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notifications(p_limit integer) TO project_admin;

REVOKE ALL ON FUNCTION public.get_public_profiles() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_public_profiles() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_recent_checkins(p_event_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_recent_checkins(p_event_id uuid, p_limit integer) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.get_scan_log(p_event_id uuid, p_result text, p_limit integer, p_offset integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_scan_log(p_event_id uuid, p_result text, p_limit integer, p_offset integer) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.heartbeat_presence() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.heartbeat_presence() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.is_admin_or_root() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_admin_or_root() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.is_email_verified() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_email_verified() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.is_event_door_manager(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_event_door_manager(p_event_id uuid) TO project_admin;

REVOKE ALL ON FUNCTION public.is_organizer() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_organizer() TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.is_root() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_root() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.lift_expired_bans() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.lift_expired_bans() TO project_admin;

REVOKE ALL ON FUNCTION public.lock_admin_root_role() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.lock_admin_root_role() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.log_organizer_promotion(p_user_id uuid, p_email text, p_username text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.log_organizer_promotion(p_user_id uuid, p_email text, p_username text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.log_scan_attempt(p_event_id uuid, p_ticket_id uuid, p_scanned_by uuid, p_result text, p_reason text, p_message text, p_device_id text, p_gate_name text, p_is_manual boolean) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.log_scan_attempt(p_event_id uuid, p_ticket_id uuid, p_scanned_by uuid, p_result text, p_reason text, p_message text, p_device_id text, p_gate_name text, p_is_manual boolean) TO project_admin;

REVOKE ALL ON FUNCTION public.manual_check_in(p_ticket_id uuid, p_actor_id uuid, p_device_id text, p_gate_name text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.manual_check_in(p_ticket_id uuid, p_actor_id uuid, p_device_id text, p_gate_name text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.mark_notifications_pushed(p_ids uuid[]) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.mark_notifications_pushed(p_ids uuid[]) TO project_admin;

REVOKE ALL ON FUNCTION public.my_latest_organizer_verification() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.my_latest_organizer_verification() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_admin_stats_payout() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_admin_stats_payout() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_admin_stats_signup() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_admin_stats_signup() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_admin_stats_transaction() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_admin_stats_transaction() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_door_checkin() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_door_checkin() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_door_scan() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_door_scan() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_door_ticket() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_door_ticket() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_event_update() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_event_update() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_new_direct_message() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_new_direct_message() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_new_notification() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_new_notification() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_organizer_events_event() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_organizer_events_event() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_organizer_events_ticket() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_organizer_events_ticket() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_icon text, p_push_data jsonb) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_icon text, p_push_data jsonb) TO project_admin;

REVOKE ALL ON FUNCTION public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_icon text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_icon text) TO project_admin;

REVOKE ALL ON FUNCTION public.notify_vc_update() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_vc_update() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.promote_to_organizer() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.promote_to_organizer() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.protect_admin_tier_status_columns() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.protect_admin_tier_status_columns() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.protect_event_promotion_columns() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.protect_event_promotion_columns() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.protect_trust_signal_columns() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.protect_trust_signal_columns() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.prune_push_token(p_token text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.prune_push_token(p_token text) TO project_admin;

REVOKE ALL ON FUNCTION public.purchase_badge(p_badge_type text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.purchase_badge(p_badge_type text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.purchase_ticket_with_tokens(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.purchase_ticket_with_tokens(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.reclaim_unverified_signup(p_email text, p_phone text, p_username text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.reclaim_unverified_signup(p_email text, p_phone text, p_username text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.referral_count_today(p_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.referral_count_today(p_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.register_push_token(p_user_id uuid, p_token text, p_platform text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.register_push_token(p_user_id uuid, p_token text, p_platform text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.reject_admin_action(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.reject_admin_action(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.reject_injection_patterns(p_label text, p_text text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.reject_injection_patterns(p_label text, p_text text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.remove_bank_account_confirmed(p_account_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.remove_bank_account_confirmed(p_account_id uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.remove_push_tokens_for_user(p_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.remove_push_tokens_for_user(p_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.request_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_target_label text, p_payload jsonb, p_previous_values jsonb, p_requested_changes jsonb, p_device text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.request_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_target_label text, p_payload jsonb, p_previous_values jsonb, p_requested_changes jsonb, p_device text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.resolve_username_to_email(p_username text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.resolve_username_to_email(p_username text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.respond_to_message_request(p_requester_id uuid, p_action text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.respond_to_message_request(p_requester_id uuid, p_action text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.run_event_reminder_sweep() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.run_event_reminder_sweep() TO project_admin;

REVOKE ALL ON FUNCTION public.scan_reason_to_result(p_reason text, p_message text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.scan_reason_to_result(p_reason text, p_message text) TO project_admin;

REVOKE ALL ON FUNCTION public.search_direct_messages(p_query text, p_other_user_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.search_direct_messages(p_query text, p_other_user_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.search_events_fuzzy(p_query text, p_limit integer, p_offset integer, p_exclude_18_plus boolean) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.search_events_fuzzy(p_query text, p_limit integer, p_offset integer, p_exclude_18_plus boolean) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.send_direct_message(p_recipient_id uuid, p_body text, p_event_id uuid, p_image_url text, p_media_type text, p_reply_to_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.send_direct_message(p_recipient_id uuid, p_body text, p_event_id uuid, p_image_url text, p_media_type text, p_reply_to_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.send_event_reminders() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.send_event_reminders() TO project_admin;

REVOKE ALL ON FUNCTION public.set_default_bank_account_confirmed(p_account_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_default_bank_account_confirmed(p_account_id uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.set_event_payout_account() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_event_payout_account() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.set_referral_pending_until() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_referral_pending_until() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.set_signup_role(p_role text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_signup_role(p_role text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.soft_delete_event(p_event_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.soft_delete_event(p_event_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.submit_organizer_review(p_organizer_id uuid, p_rating smallint, p_body text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.submit_organizer_review(p_organizer_id uuid, p_rating smallint, p_body text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.submit_organizer_verification(p_company_name text, p_cac_number text, p_business_address text, p_document_url text, p_owner_name text, p_registration_date date, p_business_email text, p_business_phone text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.submit_organizer_verification(p_company_name text, p_cac_number text, p_business_address text, p_document_url text, p_owner_name text, p_registration_date date, p_business_email text, p_business_phone text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.trg_sync_vc_to_wallet() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.trg_sync_vc_to_wallet() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.unblock_user(p_blocked_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.unblock_user(p_blocked_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.upsert_organizer_bank_account(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.upsert_organizer_bank_account(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text) TO project_admin;

REVOKE ALL ON FUNCTION public.upsert_privacy_settings(p_profile_visible text, p_can_message text, p_show_in_search boolean, p_show_attended_events boolean) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.upsert_privacy_settings(p_profile_visible text, p_can_message text, p_show_in_search boolean, p_show_attended_events boolean) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.validate_event_ticket_types() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.validate_event_ticket_types() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.validate_events_input() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.validate_events_input() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.validate_promo_code(p_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.validate_promo_code(p_code text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.validate_users_input() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.validate_users_input() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid, p_device_id text, p_gate_name text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid, p_device_id text, p_gate_name text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.whoami_admin() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.whoami_admin() TO anon, authenticated, project_admin;

-- Table-level privileges, reconstructed from the live InsForge project's
-- actual current grants. Several tables (tickets, pending_purchases,
-- organizer_bank_accounts, direct_messages) have direct client writes
-- deliberately revoked and funneled through SECURITY DEFINER RPCs instead —
-- preserve these exactly, they are documented security hardening, not defaults.

-- admin_action_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_action_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_action_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.admin_action_requests TO project_admin;

-- admin_logs
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_logs TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.admin_logs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.admin_logs TO project_admin;

-- app_config
GRANT DELETE, INSERT, SELECT, UPDATE ON public.app_config TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.app_config TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.app_config TO project_admin;

-- blocked_users
GRANT DELETE, INSERT, SELECT, UPDATE ON public.blocked_users TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.blocked_users TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.blocked_users TO project_admin;

-- checkins
GRANT DELETE, INSERT, SELECT, UPDATE ON public.checkins TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.checkins TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.checkins TO project_admin;

-- conversation_clears
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_clears TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_clears TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.conversation_clears TO project_admin;

-- conversation_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversation_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.conversation_requests TO project_admin;

-- deleted_emails
GRANT DELETE, INSERT, SELECT, UPDATE ON public.deleted_emails TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.deleted_emails TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.deleted_emails TO project_admin;

-- deleted_phones
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.deleted_phones TO project_admin;

-- device_fingerprints
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_fingerprints TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_fingerprints TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.device_fingerprints TO project_admin;

-- device_push_tokens
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_push_tokens TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.device_push_tokens TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.device_push_tokens TO project_admin;

-- direct_messages
GRANT DELETE, INSERT, SELECT, UPDATE ON public.direct_messages TO anon;
GRANT DELETE, SELECT, UPDATE ON public.direct_messages TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.direct_messages TO project_admin;

-- event_promotions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_promotions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_promotions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.event_promotions TO project_admin;

-- event_reminder_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_reminder_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_reminder_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.event_reminder_log TO project_admin;

-- events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.events TO project_admin;

-- highlights
GRANT DELETE, INSERT, SELECT, UPDATE ON public.highlights TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.highlights TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.highlights TO project_admin;

-- media_assets
GRANT DELETE, INSERT, SELECT, UPDATE ON public.media_assets TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.media_assets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.media_assets TO project_admin;

-- message_reactions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.message_reactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.message_reactions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.message_reactions TO project_admin;

-- notifications
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.notifications TO project_admin;

-- organizer_bank_accounts
GRANT SELECT ON public.organizer_bank_accounts TO anon;
GRANT SELECT ON public.organizer_bank_accounts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_bank_accounts TO project_admin;

-- organizer_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_requests TO project_admin;

-- organizer_reviews
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_reviews TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_reviews TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_reviews TO project_admin;

-- organizer_transactions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_transactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_transactions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_transactions TO project_admin;

-- organizer_verification_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_verification_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_verification_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_verification_requests TO project_admin;

-- organizer_wallets
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_wallets TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_wallets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_wallets TO project_admin;

-- organizer_withdrawal_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_withdrawal_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.organizer_withdrawal_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.organizer_withdrawal_requests TO project_admin;

-- pending_purchases
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.pending_purchases TO project_admin;

-- promo_codes
GRANT DELETE, INSERT, SELECT, UPDATE ON public.promo_codes TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.promo_codes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.promo_codes TO project_admin;

-- public_profiles
GRANT DELETE, INSERT, SELECT, UPDATE ON public.public_profiles TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.public_profiles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.public_profiles TO project_admin;

-- rate_limits
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rate_limits TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rate_limits TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.rate_limits TO project_admin;

-- referrals
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referrals TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referrals TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referrals TO project_admin;

-- referred_emails
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referred_emails TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.referred_emails TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referred_emails TO project_admin;

-- reports
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reports TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reports TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.reports TO project_admin;

-- saved_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.saved_events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.saved_events TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.saved_events TO project_admin;

-- scan_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.scan_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.scan_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.scan_log TO project_admin;

-- search_synonyms
GRANT DELETE, INSERT, SELECT, UPDATE ON public.search_synonyms TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.search_synonyms TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.search_synonyms TO project_admin;

-- tickets
GRANT SELECT ON public.tickets TO anon;
GRANT SELECT ON public.tickets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tickets TO project_admin;

-- user_privacy_settings
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_privacy_settings TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_privacy_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_privacy_settings TO project_admin;

-- users
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.users TO project_admin;

-- vc_bonuses
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_bonuses TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_bonuses TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vc_bonuses TO project_admin;

-- vc_event_boosts
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_event_boosts TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_event_boosts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vc_event_boosts TO project_admin;

-- vc_transactions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_transactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_transactions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vc_transactions TO project_admin;

-- vents_wallets
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vents_wallets TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vents_wallets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vents_wallets TO project_admin;
