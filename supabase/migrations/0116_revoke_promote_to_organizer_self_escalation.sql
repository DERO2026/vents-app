-- promote_to_organizer() is a SECURITY DEFINER function that unconditionally
-- sets the CALLING user's own role to 'organizer' -- no admin check, no
-- organizer_requests row, no gating of any kind (only an admin-role guard
-- against re-promoting an existing admin). It was granted EXECUTE to both
-- anon and authenticated, so any signed-in user (this function itself
-- requires auth.uid() IS NOT NULL, so not anon in practice, but the grant
-- was still present) could call `supabase.rpc('promote_to_organizer')`
-- directly from a browser console and instantly self-promote, completely
-- bypassing the real "Become an Organizer" application/review flow:
-- organizer_requests (pending/approved/rejected, submitted via
-- ProfileScreen's application form) reviewed by a Super Admin through
-- admin_decide_organizer_request, which is the ONLY path that is supposed
-- to grant the organizer role (via admin_set_user_role).
--
-- The only client callers of promote_to_organizer were a dead, unreachable
-- code path in App.tsx (an `onBecomeOrganizer` prop and an organizer branch
-- of `setActiveView` that ProfileScreen never actually invokes -- it opens
-- the organizer_requests application modal instead) which is being removed
-- in the same change. admin_decide_organizer_request does not call this
-- function either -- it promotes via admin_set_user_role directly. So
-- promote_to_organizer has no legitimate remaining caller; revoke EXECUTE
-- from anon and authenticated so it can no longer be invoked as a
-- self-service privilege-escalation RPC. Left in place (not dropped) in
-- case any server-side/admin tooling still references it; only reachable
-- by postgres/project_admin from here on.

REVOKE EXECUTE ON FUNCTION public.promote_to_organizer() FROM anon;
REVOKE EXECUTE ON FUNCTION public.promote_to_organizer() FROM authenticated;
