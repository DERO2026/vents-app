-- confirm_ticket_payment / finalize_ticket_refund / fail_ticket_refund had
-- EXECUTE granted to anon and authenticated with ZERO internal auth check —
-- the same shape as the payout hole closed in
-- 20260731070000_lockdown-payout-completion-rpcs.sql.
--
-- confirm_ticket_payment: the client itself chooses p_reference
-- (App.tsx purchase flow uses ticket.ticketId or a timestamp fallback), and
-- p_amount_kobo is a deterministic formula over values the buyer already
-- knows. A signed-in user could create pending ticket rows via the normal
-- purchase flow, abandon the Paystack popup, then call this RPC directly
-- over the InsForge REST surface with their own reference/amount to mark
-- tickets paid and credit the organizer's wallet — free tickets plus
-- phantom withdrawable balance, with no real payment ever occurring.
--
-- finalize_ticket_refund / fail_ticket_refund: keyed only on p_refund_id,
-- which is Paystack's own numeric refund id — a short, sequential,
-- enumerable value. fail_ticket_refund reverts a refund-pending ticket back
-- to paid/active and writes an admin_logs row impersonating the webhook
-- (actor_role='webhook'), so this is both a fraud vector and an audit-log
-- forgery vector.
--
-- All three RPCs are meant to be called only by the Paystack webhook
-- (HMAC-signature verified in api/webhook/paystack.ts), which now
-- authenticates with the admin-only API_KEY secret instead of the
-- client-exposed anon key. Revoking anon/authenticated EXECUTE here closes
-- the RPC-level hole those code changes assume is closed.
REVOKE EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_ticket_refund(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_ticket_refund(text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) TO project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_ticket_refund(text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.fail_ticket_refund(text, text) TO project_admin;
