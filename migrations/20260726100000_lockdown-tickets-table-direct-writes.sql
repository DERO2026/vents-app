-- ── Close direct-write RLS/GRANT bypass on public.tickets ────────────────────
-- Audit finding (CRITICAL): `authenticated` (and `anon`) held direct table-level
-- INSERT/UPDATE/DELETE on public.tickets. The insert_tickets/update_tickets RLS
-- policies only check row OWNERSHIP (user_id = auth.uid(), or organizer-of-event
-- for updates) -- they never restrict which VALUES can be written. Combined with
-- the open table grant, any authenticated user could POST/PATCH public.tickets
-- directly via the REST API and set payment_status='paid', amount=0, status=
-- 'active', etc. on a self-owned row for any real event, completely bypassing
-- purchase_ticket/confirm_ticket_payment/refund_ticket and their fraud checks.
--
-- Verified safe to revoke: every legitimate write path already goes through a
-- SECURITY DEFINER function (purchase_ticket, purchase_ticket_with_tokens,
-- confirm_ticket_payment, refund_ticket, attach_ticket_refund_id,
-- finalize_ticket_refund, fail_ticket_refund, admin_revert_stuck_refund,
-- verify_entry_pass, manual_check_in, and the door-manager RPCs). SECURITY
-- DEFINER functions execute as the function owner (project_admin), which is
-- untouched here, so none of them are affected by revoking authenticated/anon's
-- direct table grant. A full repo grep confirmed no client or API code performs
-- a raw .insert()/.update()/.delete() against 'tickets' -- every write site is
-- an RPC call.
--
-- SELECT is intentionally left in place: select_tickets RLS already scopes rows
-- to the ticket owner or the event's organizer, and read access doesn't carry
-- the same fraud risk as write access.

REVOKE INSERT, UPDATE, DELETE ON public.tickets FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.tickets FROM anon;
