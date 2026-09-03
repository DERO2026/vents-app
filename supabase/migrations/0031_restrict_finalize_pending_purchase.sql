-- Security fix: finalize_pending_purchase() creates an ACTIVE, check-in-
-- scannable ticket row (status = 'active') the moment it's called, but
-- never itself verifies payment — the only real payment verification is
-- confirm_ticket_payment() (already project_admin-only, called exclusively
-- by api/webhook/paystack.ts after its own HMAC signature check against
-- Paystack). manual_check_in() only ever checks tickets.status = 'active',
-- never payment_status, so a ticket created this way is fully usable at
-- the door regardless of whether payment_status is 'pending' or 'paid'.
--
-- finalize_pending_purchase() was, until now, GRANTed to `authenticated`
-- (0011_grants.sql) — meaning any signed-in client could call
-- create_pending_purchase() followed immediately by
-- finalize_pending_purchase() for a paid event and receive a fully
-- working, scannable ticket without ever touching Paystack. This is
-- exactly the "returning from Paystack treated as proof of payment"
-- failure mode, except it didn't even require returning from Paystack —
-- calling the RPC directly was enough.
--
-- Fixed at the same boundary confirm_ticket_payment() already uses:
-- restrict finalize_pending_purchase() to project_admin only. The only
-- callers now are api/webhook/paystack.ts (unchanged, already uses the
-- project_admin connection) and the new api/payments/verify.ts, which
-- calls Paystack's own GET /transaction/verify/:reference with the secret
-- key server-side BEFORE calling this function -- see api/_lib/
-- finalizePaystackPayment.ts. The free-ticket path
-- (purchase_ticket_with_tokens, called directly by the client) is
-- unaffected -- it never touches pending_purchases or Paystack.
REVOKE ALL ON FUNCTION public.finalize_pending_purchase(p_payment_ref text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_pending_purchase(p_payment_ref text) TO project_admin;

-- Small project_admin-only lookup so api/payments/verify.ts (which runs
-- entirely over the project_admin connection, same as the webhook) can
-- return the finalized ticket ids to the client after finalizing +
-- confirming payment, without needing a raw SQL query from the API layer.
-- generate_ticket_token() itself is already authenticated-callable
-- (0011_grants.sql), so the client generates its own tokens from these ids
-- exactly like every other ticket-issuing path already does.
CREATE OR REPLACE FUNCTION public.get_tickets_for_payment_ref(p_payment_ref text)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT t.id FROM public.tickets t WHERE t.payment_ref = p_payment_ref AND t.status = 'active';
$function$;

REVOKE ALL ON FUNCTION public.get_tickets_for_payment_ref(p_payment_ref text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_tickets_for_payment_ref(p_payment_ref text) TO project_admin;

-- pending_purchases has RLS enabled with no policies at all (0008), so it's
-- unreadable by anon/authenticated by design -- api/payments/verify.ts
-- (running over the project_admin connection, no user JWT/RLS context of
-- its own) needs this to confirm the authenticated caller who hit that
-- endpoint actually owns the reference they're asking to verify, before
-- ever calling Paystack's verify API or finalizing anything on their say-so.
CREATE OR REPLACE FUNCTION public.get_pending_purchase_owner(p_payment_ref text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT user_id FROM public.pending_purchases WHERE payment_ref = p_payment_ref;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_purchase_owner(p_payment_ref text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_pending_purchase_owner(p_payment_ref text) TO project_admin;
