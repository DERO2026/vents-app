-- Final Admin Console audit fixes.
--
-- FINDING 1 (stale "Not available" -- real functionality already existed
-- server-side, just never wired to the UI): AdminUserDetail.tsx's Wallet
-- and VC tabs claimed "no admin-accessible query or RPC exists" for a
-- specific user's VENTS Wallet / VC transactions. That was true when
-- originally written but is no longer accurate: user_wallets,
-- user_wallet_transactions, and vc_transactions all already carry an
-- `is_admin()` SELECT policy (user_wallets_admin_select,
-- user_wallet_transactions_admin_select, vc_transactions_admin_select).
-- Only vents_wallets (the VC balance row itself, distinct from the
-- vc_transactions ledger) was missing the equivalent -- added here so the
-- full picture (balance + ledger) is admin-readable, matching the other
-- three tables' existing pattern exactly (SELECT-only, is_admin()).
CREATE POLICY vents_wallets_admin_select ON public.vents_wallets
  FOR SELECT
  USING (public.is_admin());
