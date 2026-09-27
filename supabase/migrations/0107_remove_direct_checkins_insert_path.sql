-- Master security audit (HIGH #2): the `organizer_insert_checkins` RLS
-- policy let any authenticated organizer INSERT directly into
-- public.checkins -- the check-in audit trail -- as long as event_id
-- belonged to one of their events and ticket_id belonged to that event.
-- Its WITH CHECK does not constrain scanned_by, checked_in_at,
-- device_id, gate_name, or is_manual_override, and it never looks at
-- ticket.status or ticket.checked_in. That means an organizer could:
--   - forge scanned_by as any user (impersonating a different scanner)
--   - backdate/forward-date checked_in_at
--   - write a "check-in" audit row for a refunded/cancelled/expired
--     ticket, or for a ticket that was never actually scanned
--   - do all of this without ever going through verify_entry_pass or
--     manual_check_in, and without ever touching tickets.checked_in
--     (which stays false), so the row is a pure forged audit entry
--     sitting alongside genuine ones in the same table.
--
-- The real admission gate (tickets.checked_in) already can't be set this
-- way -- only verify_entry_pass/manual_check_in update it, both
-- SECURITY DEFINER, both already correctly authorized and already the
-- sole legitimate producers of checkins rows (see their INSERT INTO
-- public.checkins statements). This policy is a redundant, unconstrained
-- second write path that exists for no legitimate product reason.
--
-- Fix: drop the policy entirely. SECURITY DEFINER functions run as their
-- owning role (postgres), which bypasses RLS, so verify_entry_pass and
-- manual_check_in are completely unaffected -- their own INSERT INTO
-- checkins keeps working exactly as before. Also revoke the INSERT grant
-- itself from anon/authenticated as defense-in-depth: even if a future
-- policy were added back carelessly, the grant layer alone would still
-- block direct client inserts. UPDATE/DELETE/SELECT grants and the
-- existing SELECT policies are untouched (out of scope for this fix;
-- tracked separately for broader grant hardening).

DROP POLICY IF EXISTS organizer_insert_checkins ON public.checkins;

REVOKE INSERT ON public.checkins FROM anon, authenticated;
