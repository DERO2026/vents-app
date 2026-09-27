-- Master security audit (MEDIUM #2, #3, #7): several money-adjacent and
-- audit-trail tables had INSERT/UPDATE/DELETE granted to anon AND
-- authenticated at the table-grant layer, backstopped ENTIRELY by RLS
-- (most have no write policy at all -- default-deny; a couple have a
-- narrow admin-only or own-row policy). This is the exact "grant without
-- an airtight policy" fragility pattern that already caused two real bugs
-- this session (tickets' now-removed update_tickets/insert_tickets
-- policies, and admin_credit_vents_cents' double-credit). Every
-- legitimate write to every one of these tables already goes through a
-- SECURITY DEFINER function (confirmed live: complete_organizer_payout,
-- confirm_ticket_payment_via_wallet, cancel_service_booking,
-- finalize_ticket_refund, finalize_service_booking_refund, _vc_deduct,
-- _vc_restore, request_vc_cashout, credit_organizer_wallet,
-- initiate_ticket_transfer, admin_credit_vents_cents, complete_referral,
-- confirm_ticket_payment, log_scan_attempt, refund_ticket,
-- request_organizer_payout, credit_provider_wallet_for_booking, plus
-- verify_entry_pass/manual_check_in for checkins/scan_log), which all run
-- as their owning role and bypass RLS/grants entirely -- so revoking these
-- grants is behavior-preserving for every real code path.
--
-- MEDIUM #2 -- wallet/VC tables: vc_transactions, vents_wallets,
-- vc_bonuses, vc_withdrawal_requests, organizer_wallets,
-- organizer_transactions, organizer_withdrawal_requests.
--   Special note on vc_bonuses: unlike the rest of this list, it DOES have
--   a real client-writable policy today (vcb_own, ALL, USING
--   user_id = auth.uid(), no separate WITH CHECK so USING doubles as the
--   check) -- a user could otherwise INSERT their own arbitrary
--   (user_id, bonus_type) row directly. Nothing found reads that as proof
--   of a real grant (claim_profile_bonus/purchase_badge both write it
--   themselves via ON CONFLICT), but it's a needless direct-write surface
--   for a bonus/rewards ledger; closing the INSERT grant removes it while
--   leaving the SELECT-relevant qual (own-row read visibility, if any
--   depends on it elsewhere) untouched -- this migration only touches
--   INSERT/UPDATE/DELETE grants, never SELECT.
--
-- MEDIUM #3 -- checkins' organizer_insert_checkins policy was already
-- removed in 0107 (HIGH #2); this closes the same pattern on its two
-- siblings: scan_log (the scan-attempt audit trail written only by
-- log_scan_attempt) and ticket_transfers (written only by
-- initiate_ticket_transfer and its accept/expire/fee-confirmation
-- counterparts).
--
-- MEDIUM #7 -- admin_action_requests (the maker-checker dual-control
-- queue for request_admin_action/approve_admin_action) has zero RLS
-- policies today -- already default-deny and safe, but a single point of
-- failure if a future policy were ever added carelessly. Revoking the
-- grant is defense-in-depth on top of that default-deny, not a behavior
-- change: request_admin_action/approve_admin_action are SECURITY DEFINER
-- and bypass this entirely.
--
-- SELECT and any existing read/admin-write policies are untouched. No
-- function or policy is created or dropped by this migration.

REVOKE INSERT, UPDATE, DELETE ON public.vc_transactions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vents_wallets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vc_bonuses FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vc_withdrawal_requests FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.organizer_wallets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.organizer_transactions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.organizer_withdrawal_requests FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.scan_log FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ticket_transfers FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.admin_action_requests FROM anon, authenticated;
