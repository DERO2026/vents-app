-- P0 security fix (Admin Console audit): organizer_wallets_admin_write was
-- `FOR ALL ... USING (is_admin()) WITH CHECK (is_admin())`, scoped to
-- {public}, with NO exclusion for the admin's own row. Any admin/sub-admin
-- could call `supabase.from('organizer_wallets').update({...}).eq
-- ('organizer_id', <their own id>)` directly via PostgREST -- a complete
-- bypass of admin_credit_vents_cents/admin_debit_vents_cents's self-credit
-- guard (0095), the double-credit fix (0096), and the admin_logs audit
-- trail those RPCs write. The RPC-level fixes did nothing to stop this,
-- since a direct table write never goes through them.
--
-- Fix: the same policy, but excluding the admin's own row
-- (organizer_id <> auth.uid()) and scoped to {authenticated} rather than
-- {public} (the only other policy on this table is already {authenticated}
-- -- {public} here was inconsistent with the rest of the table, not
-- intentional). This still lets an admin manage OTHER organizers' wallets
-- directly if that's ever needed (no functionality removed for the
-- legitimate case), and does nothing to admin_credit_vents_cents/
-- admin_debit_vents_cents themselves -- those are SECURITY DEFINER
-- functions that run as their owner and are not subject to this table's
-- RLS, so legitimate credit/debit/payout flows are unaffected. It also
-- does not touch user_wallets (member wallets already have no write
-- policy for anyone, confirmed separately).
DROP POLICY IF EXISTS organizer_wallets_admin_write ON public.organizer_wallets;

CREATE POLICY organizer_wallets_admin_write ON public.organizer_wallets
  FOR ALL TO authenticated
  USING (public.is_admin() AND organizer_id <> auth.uid())
  WITH CHECK (public.is_admin() AND organizer_id <> auth.uid());
