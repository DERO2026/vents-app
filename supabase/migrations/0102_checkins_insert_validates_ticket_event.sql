-- Large-event scalability/security audit finding #7 (MEDIUM): the
-- checkins table's only INSERT policy, organizer_insert_checkins, checked
-- that the caller owns event_id but never verified ticket_id actually
-- belongs to that event_id:
--
--   with_check = (event_id IN (SELECT id FROM events WHERE organizer_id = auth.uid()))
--
-- An authenticated organizer's own client could therefore directly
-- `INSERT INTO checkins (ticket_id, event_id, ...)` with a ticket_id from
-- ANY event (including one they don't own) as long as event_id named one
-- of their own events -- a cross-event ticket/check-in injection into the
-- checkins audit ledger.
--
-- Impact is bounded (confirmed in the security audit): this table is
-- audit/attribution only. The real admission gate is tickets.checked_in,
-- which this policy change cannot touch -- door_stats(), get_door_stats,
-- and get_event_attendees all compute "checked in" from tickets.checked_in,
-- never from the presence of a checkins row. verify_entry_pass and
-- manual_check_in (the only functions that ever flip tickets.checked_in)
-- are SECURITY DEFINER and run as the function owner, which bypasses RLS
-- entirely -- this policy tightening does not touch their INSERT INTO
-- checkins statement or its ON CONFLICT (ticket_id) DO NOTHING semantics
-- in any way. So this fix closes an audit-integrity/injection gap in
-- direct-client access, not an admission-bypass bug.
--
-- Fix: add "AND ticket_id IN (SELECT id FROM tickets WHERE event_id =
-- checkins.event_id)" to the existing WITH CHECK -- the smallest possible
-- change, preserving every other clause and every other checkins policy
-- (organizer_select_checkins, owner_select_checkins) unchanged.

DROP POLICY IF EXISTS organizer_insert_checkins ON public.checkins;

CREATE POLICY organizer_insert_checkins
  ON public.checkins
  FOR INSERT
  TO authenticated
  WITH CHECK (
    event_id IN (SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid()))
    AND ticket_id IN (SELECT id FROM public.tickets WHERE event_id = checkins.event_id)
  );
