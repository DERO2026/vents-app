-- Master security audit (MEDIUM #6): 41 admin-only and authenticated-only
-- RPCs still had EXECUTE granted to anon -- the same unnecessary-attack-
-- surface pattern already closed for verify_entry_pass/manual_check_in/
-- refund_ticket (migration 0104) and the Door Manager read RPCs
-- (migration 0105). Every one of these was confirmed live to already be
-- unreachable by an anon (unauthenticated) caller through its own
-- internal authorization check, not through this grant:
--   - The 36 admin_* functions each check the caller's admin status
--     (is_admin()/is_admin_or_root()/is_super_admin(), or an inline
--     `role = 'admin'` lookup for admin_send_broadcast/admin_broadcast),
--     which requires a resolved auth.uid() -- NULL for anon, so these
--     already raise "Only admins..."/"...access required" for an anon
--     caller today.
--   - claim_profile_bonus, complete_referral, purchase_badge,
--     request_organizer_payout, and request_vc_cashout each require
--     auth.uid() IS NOT NULL as their first check (verified live in each
--     function body), so an anon caller already gets "Not authenticated".
--
-- Not exploitable either way -- this is pure unnecessary EXECUTE surface,
-- same reasoning as 0104/0105. No function body changes.

REVOKE EXECUTE ON FUNCTION public.admin_approve_organizer_verification(p_request_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_broadcast(p_title text, p_body text, p_type text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_cancel_processing_vc_payout(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_claim_vc_payout_for_processing(p_request_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_new_user_stats() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_vc_aggregates() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_verification_stats() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_health_ping() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_action_requests(p_status text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_pending_payouts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_pending_vc_payouts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_processing_payouts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_processing_vc_payouts() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_list_push_tokens(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_mark_all_requests_seen() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_mark_request_seen(p_request_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_mark_vc_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_pending_request_count() FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_prune_push_token(p_token text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_reinstate_user(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_reject_vc_payout(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_release_payout_claim(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_release_vc_payout_claim(p_request_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_restore_deleted_event(p_event_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_send_broadcast(p_title text, p_body text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_suspend_user(p_user_id uuid, p_banned_until timestamp with time zone, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_user_verified(p_user_id uuid, p_verified boolean, p_reason text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_unsuspend_user(p_user_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_profile_bonus() FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_referral(p_referrer_code text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.purchase_badge(p_badge_type text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text) FROM anon;
