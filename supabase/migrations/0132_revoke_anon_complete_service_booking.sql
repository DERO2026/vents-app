-- Services end-to-end reconciliation audit: complete_service_booking was
-- GRANTed EXECUTE to anon, inconsistent with every sibling privileged
-- function in this codebase (confirm_ticket_payment_via_wallet,
-- cancel_service_booking, etc.), all of which revoke anon as defense-in-
-- depth even when the function's own internal `auth.uid() IS NULL` check
-- already makes it unreachable by a true anonymous caller (anon has no
-- session, so auth.uid() is always NULL for it; this was not an active
-- exploit path). Locking it down for consistency with the established
-- pattern -- no behavior change for any authenticated caller.
REVOKE EXECUTE ON FUNCTION public.complete_service_booking(uuid) FROM anon;
