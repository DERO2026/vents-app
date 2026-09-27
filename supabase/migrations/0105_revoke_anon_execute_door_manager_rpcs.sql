-- Follow-up to 0104: the regression-audit agent flagged that
-- get_recent_checkins was still anon-executable, same pattern class as
-- verify_entry_pass/manual_check_in/refund_ticket. Checking its three
-- sibling Door Manager RPCs (get_door_stats, get_event_attendees,
-- get_scan_log) found the same thing -- all four are SECURITY DEFINER,
-- all four gate on is_event_door_manager(p_event_id), which requires
-- auth.uid() to resolve to the event's organizer or an admin. For an
-- anon (unauthenticated) caller, auth.uid() is NULL, so
-- is_event_door_manager() already evaluates false and every one of these
-- four raises 'Not authorized for this event''s door' today -- not
-- exploitable, but unnecessary EXECUTE surface for functions that require
-- authentication, exactly the same reasoning 0104 applied to the other
-- three.

REVOKE EXECUTE ON FUNCTION public.get_recent_checkins(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_door_stats(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_event_attendees(uuid, text, text, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_scan_log(uuid, text, integer, integer) FROM anon;
