-- Admin/Sub-Admin must have the same reach over Services as they do over
-- every other admin-managed section (organizer events, payouts, etc.) --
-- able to create/manage a provider listing without being blocked by the
-- ordinary provider-capability gate (users.is_service_provider). is_admin()
-- already covers both 'admin' and 'sub-admin' roles (and root) -- see
-- is_admin() in 0004_functions.sql. service_providers already had
-- admin SELECT/UPDATE/DELETE bypass policies (0034); the one gap was
-- INSERT, which only had the capability-gated service_providers_insert_own
-- policy -- an admin with is_service_provider = false could not create
-- their own first listing at all. This migration only adds the missing
-- admin INSERT bypass; it does NOT weaken service_providers_insert_own,
-- does NOT touch RLS on service_provider_requests, organizer_* tables, or
-- any Organizer verification architecture, and does NOT expose any of this
-- to a plain authenticated user (is_admin() itself is SECURITY DEFINER and
-- re-checks the caller's own role server-side on every evaluation).
CREATE POLICY service_providers_admin_insert ON public.service_providers
  FOR INSERT
  TO authenticated
  WITH CHECK (is_admin());
