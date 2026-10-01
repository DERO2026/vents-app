-- Notifications/Push audit: register_push_token and
-- remove_push_tokens_for_user both carried anon EXECUTE grants, the same
-- grant-hygiene gap already fixed this reconciliation pass for
-- complete_service_booking and generate_ticket_token. Not an active
-- exploit for either -- both have a correct internal
-- `auth.uid() <> p_user_id` ownership check, and anon always has
-- auth.uid() = NULL -- but every comparable function in this codebase
-- revokes anon as defense-in-depth. No behavior change for any
-- authenticated caller.
REVOKE EXECUTE ON FUNCTION public.register_push_token(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_push_tokens_for_user(uuid) FROM anon;
