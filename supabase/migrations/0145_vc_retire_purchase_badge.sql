-- Batch D: retire the old purchased-badge economy. The new VENTS Cents
-- tier/multiplier system (Batch A: users.vc_lifetime_earned,
-- vc_badge_tiers, vc_tier_for_lifetime(), vc_multiplier_for_tier(),
-- vc_tier_and_multiplier_for_user()) has never read users.vc_badge for
-- any tier/multiplier/privilege decision -- confirmed by inspecting every
-- function body referencing vc_badge in production: only
-- get_public_profiles() and search_events_fuzzy() read it, both purely
-- for read-only display, and protect_trust_signal_columns() only guards
-- writes to it. So purchase_badge() was already structurally incapable of
-- affecting the new lifetime-earned tier. This migration closes the
-- remaining real problem: a user could still spend real VC on
-- purchase_badge() today and receive nothing of value in the new economy
-- (a vc_badge value nothing authoritative reads), which is a silent
-- financial trap, not a tier-integrity bug.
--
-- Already applied live to production (project slrtjxtzhowhwhebjprv) via
-- the Supabase MCP apply_migration tool, under the live migration name
-- `vc_retire_purchase_badge`.
--
-- Legacy history preservation (audited before this migration, no table
-- created or altered): production has 6 users with a non-null vc_badge
-- (2 bronze, 1 gold, 1 platinum, 1 elite, 1 legend) and a complete,
-- already-existing append-only purchase history in vc_bonuses
-- (bonus_type 'badge_<tier>', one row per purchase/upgrade event, with
-- its own granted_at timestamp -- one user's gold->legend upgrade is
-- preserved as two separate rows). Both users.vc_badge (current legacy
-- badge) and vc_bonuses (full purchase history) are left completely
-- untouched by this migration -- neither is read, written, renamed, nor
-- deleted. All 6 of these users currently have vc_lifetime_earned = 0
-- (new_tier = NULL, below Bronze) -- per explicit instruction, this
-- migration does NOT invent lifetime VC or retroactively award anything
-- to make old badges "match" the new tiers. Their legacy badge remains
-- visible as history; their active new-economy tier is simply not yet
-- earned, same as any other user with zero lifetime VC.
--
-- purchase_badge() is kept defined (for compatibility -- the frontend
-- still calls it via supabase.rpc('purchase_badge', ...) in
-- ReferralScreen.tsx, which surfaces a thrown error's .message directly
-- to the user) but now does nothing except raise a clear, non-technical
-- exception. No VC is deducted, users.vc_badge is never written, and no
-- vc_bonuses row is ever inserted again -- it cannot create a new, a
-- conflicting, or an upgraded legacy badge, and it cannot touch the new
-- lifetime-tier system (it never could).
CREATE OR REPLACE FUNCTION public.purchase_badge(p_badge_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RAISE EXCEPTION 'Badge purchases have been retired. Your VENTS Cents tier is now based on lifetime VC earned, not VC spent.';
END;
$function$;
