-- Tickets subsystem audit: generate_ticket_token carried an anon EXECUTE
-- grant, the same grant-hygiene inconsistency just fixed for
-- complete_service_booking (0132). Not an active exploit -- the function's
-- own internal `auth.uid() IS NULL OR auth.uid() <> v_owner` check already
-- rejects any caller who isn't the ticket's owner, and anon always has
-- auth.uid() = NULL -- but every comparable function in this codebase
-- revokes anon as defense-in-depth. No behavior change for any
-- authenticated caller.
REVOKE EXECUTE ON FUNCTION public.generate_ticket_token(uuid) FROM anon;
