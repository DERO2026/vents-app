-- Grants project_admin LOGIN privilege so server-side code (Vercel
-- functions) can connect directly via Postgres to call project_admin-
-- gated RPCs (confirm_ticket_payment, finalize_pending_purchase, etc.) —
-- those have no EXECUTE grant for anon/authenticated/service_role by
-- design. This project uses Supabase's asymmetric (ES256) JWT signing-key
-- system, which does not expose a private key for minting custom-role
-- JWTs, so the usual PostgREST role-switching-via-JWT approach isn't
-- available here; a direct connection is the supported alternative.
--
-- The actual password is set separately (via the Management API, not
-- committed here) and stored only in Vercel's server-side environment
-- variables (PROJECT_ADMIN_DATABASE_URL) — never in this repo, never
-- VITE_-prefixed, never reachable from client-side code.
--
-- Run manually (not idempotent via IF NOT EXISTS - ALTER ROLE has no such
-- guard, but re-running is harmless: it just re-sets LOGIN on a role that
-- already has it):
--   ALTER ROLE project_admin WITH LOGIN PASSWORD '<set out of band>';

ALTER ROLE project_admin WITH LOGIN;
