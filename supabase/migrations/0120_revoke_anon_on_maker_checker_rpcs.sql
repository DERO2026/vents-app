-- P2 (Admin Console audit): request_admin_action / approve_admin_action /
-- reject_admin_action had EXECUTE granted to anon in addition to
-- authenticated. Each function's body starts with `IF NOT public.is_admin()
-- THEN RAISE EXCEPTION` (or the maker-checker requester-role equivalent),
-- and is_admin() resolves against auth.uid(), which is NULL for an anon
-- (unauthenticated) request -- so an anon call already fails today. This is
-- defense-in-depth only: removing an unnecessary grant so these three
-- privileged RPCs are scoped the same way every other admin_*/privileged
-- function in this schema already is (authenticated-only), rather than
-- relying solely on the internal check never regressing.
REVOKE EXECUTE ON FUNCTION public.request_admin_action(text, text, uuid, text, jsonb, jsonb, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_admin_action(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_admin_action(uuid, text) FROM anon;
