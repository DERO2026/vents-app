-- Audit findings F15/F16 (MASTER_AUDIT.md). NOT YET APPLIED TO PRODUCTION --
-- drafted for review, pending explicit authorization per this audit's
-- constraint against unapproved changes to VC/financial schema.
--
-- F15: two old-signature admin_credit_vents_cents/admin_debit_vents_cents
-- overloads remain live alongside the correct migration-0147 replacements.
-- Both bypass _vc_pool_move() entirely -- the old credit creates VC without
-- debiting the 1,000,000,000 pool; the old debit destroys VC without
-- crediting the pool back. Confirmed dead in current app code (no caller
-- anywhere in src/ or api/ uses either old 3-arg signature -- AdminVCScreen.tsx
-- only ever calls the new 5-arg/4-arg signatures) and confirmed to have no
-- anon access (already correctly revoked by migration 0111). Safe to drop:
-- nothing calls them, and the live vc_pool_ledger's only two entries (the
-- migration-0147 reconciliation lump and the F8 "Test" credit, both using
-- the new signature) show no evidence either old overload was ever invoked.
DROP FUNCTION IF EXISTS public.admin_credit_vents_cents(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.admin_debit_vents_cents(uuid, integer, text);

-- F16: three newer VC-economy RPCs (introduced in migration 0147, after the
-- anon-EXECUTE revocation sweep in 0111) were never folded into that sweep,
-- so they still carry Postgres's default EXECUTE-to-PUBLIC grant, making
-- them anon-reachable at the grant layer. None are exploitable -- each
-- checks is_admin_or_root() internally before doing anything -- but this
-- revoke matches the exact rationale 0111 itself documents (unnecessary
-- attack surface, not a live hole). Mirrors 0111's own pattern exactly:
-- REVOKE FROM anon only, never touching authenticated/project_admin.
REVOKE EXECUTE ON FUNCTION public.admin_debit_vents_cents(uuid, integer, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_vc_summary(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.admin_get_vc_pool_status() FROM anon;
