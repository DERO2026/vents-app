-- CRITICAL finding from the organizer end-to-end reconciliation audit:
-- the events table's INSERT RLS policy only checked `auth.uid() = organizer_id
-- OR is_admin()` -- it never verified the caller actually holds the
-- is_organizer capability granted through the real Become-Organizer
-- application/approval flow (organizer_requests -> admin_decide_organizer_
-- request). CreateEventScreen.tsx inserts directly via
-- `supabase.from('events').insert([...])`, relying entirely on RLS to gate
-- who may create an event -- there is no server-side RPC in between. With
-- this gap, ANY authenticated user (is_organizer = false) could insert a
-- live event row directly over the normal PostgREST surface, with no
-- client UI involved at all, completely bypassing organizer approval --
-- and then sell real tickets against it (credit_organizer_wallet credits
-- whatever organizer_id the event row carries, with no is_organizer check
-- of its own either).
--
-- Live-verified before this fix: a confirmed is_organizer=false,
-- role='user' account could `INSERT INTO events (organizer_id, ...) VALUES
-- (<own uid>, ...)` and the row was created successfully.
--
-- Live-verified after this fix (all rolled back, no residue):
--   - the identical non-organizer direct insert now fails with
--     "new row violates row-level security policy for table events"
--   - a real is_organizer=true account's insert still succeeds unchanged
--   - an organizer attempting to insert with organizer_id set to a
--     DIFFERENT user's id (impersonation) still fails, as it always did
--
-- Fixed by adding the same is_organizer() capability check every other
-- organizer-gated RPC already uses (is_organizer() already covers role=
-- 'admin' too, so the existing is_admin() branch stays for an admin acting
-- without the flag set, e.g. creating/managing an event on an organizer's
-- behalf).
DROP POLICY IF EXISTS insert_events ON public.events;
CREATE POLICY insert_events ON public.events
  FOR INSERT
  WITH CHECK (((auth.uid() = organizer_id AND public.is_organizer()) OR public.is_admin()));
