-- Extensions, schemas, and the project_admin role.
--
-- project_admin mirrors InsForge's own convention: a non-login Postgres role
-- that owns/holds EXECUTE on every financially-sensitive function
-- (confirm_ticket_payment, credit_organizer_wallet, complete_organizer_payout,
-- fail_organizer_payout, finalize_ticket_refund, fail_ticket_refund, etc — see
-- 0010_grants.sql for the exhaustive, live-verified list). It is deliberately
-- NOT Supabase's built-in `service_role`: service_role bypasses RLS entirely,
-- which is strictly more powerful than what these functions were designed to
-- trust. Keeping a narrowly-scoped role instead preserves the original
-- privilege boundary rather than widening it "for convenience."
--
-- IMPORTANT — this role has no login and no password by design (matches
-- InsForge). Server-side code (the Paystack webhook, the payout endpoints in
-- api/wallet/*) must reach it via a DIRECT Postgres connection using
-- `SET ROLE project_admin` (or a dedicated Postgres user granted
-- `project_admin` membership), NOT via Supabase's PostgREST/RPC HTTP API,
-- which only authenticates as anon/authenticated/service_role. This is a
-- deliberate architectural decision carried over from the audit — do not
-- substitute service_role here without a security review.
CREATE ROLE project_admin NOLOGIN NOINHERIT;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- private schema: holds the ticket-QR HMAC signing secret, deliberately
-- outside `public` and outside PostgREST's exposed schema list, unreachable
-- by anon/authenticated even indirectly. See 0003_private_schema.sql.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;
