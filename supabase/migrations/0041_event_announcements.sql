-- Stage 10: Organizer -> Ticket Holder Communications.
--
-- Audit confirmed this is greenfield -- no announcement/broadcast concept
-- exists for an organizer's own event today. notifications already has
-- everything needed (no new table): INSERT is RLS-blocked for any user_id
-- other than auth.uid() itself, so a cross-user bulk insert must go
-- through a SECURITY DEFINER function, matching admin_send_broadcast's
-- exact set-based INSERT ... SELECT shape (0004_functions.sql:151-198),
-- the only existing bulk-notification precedent in this schema. Push is a
-- type-agnostic polling cron (get_pending_push_notifications reads ANY
-- notifications row with push_sent=false) -- no new plumbing needed there
-- at all; this insert is picked up automatically on the next tick.

CREATE OR REPLACE FUNCTION public.send_event_announcement(p_event_id uuid, p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event record;
  v_title text := trim(COALESCE(p_title, ''));
  v_body  text := trim(COALESCE(p_body, ''));
  v_count int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF v_title = '' THEN RAISE EXCEPTION 'Title is required'; END IF;
  IF length(v_title) > 80 THEN RAISE EXCEPTION 'Title must be 80 characters or fewer'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Message is required'; END IF;
  IF length(v_body) > 500 THEN RAISE EXCEPTION 'Message must be 500 characters or fewer'; END IF;

  SELECT id, organizer_id, deleted_at, status, hidden_by_admin, event_date
    INTO v_event
    FROM public.events
   WHERE id = p_event_id;

  IF v_event.id IS NULL THEN RAISE EXCEPTION 'Event not found'; END IF;

  -- Ownership: the event's own organizer, or an admin -- same shape as
  -- is_event_door_manager (0004_functions.sql:2117), minus its hardcoded
  -- root-UUID special case (not propagated into new code deliberately).
  IF v_event.organizer_id IS DISTINCT FROM v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only this event''s organizer can send an announcement for it';
  END IF;

  -- "Cancelled" for an event has no single status value in this schema
  -- (events_status_check only allows 'live'/'draft') -- it's represented
  -- by deleted_at (organizer removed it) or hidden_by_admin (admin pulled
  -- it), the same two flags purchase_ticket/reserve_ticket already gate
  -- purchases on (0004_functions.sql:749,755 et al).
  IF v_event.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event has been removed and can no longer receive announcements';
  END IF;
  IF v_event.hidden_by_admin THEN
    RAISE EXCEPTION 'This event has been removed and can no longer receive announcements';
  END IF;
  IF v_event.event_date < now() THEN
    RAISE EXCEPTION 'This event has already ended';
  END IF;

  -- One send per event per 15 minutes -- blocks accidental double-submit
  -- and repeated spam to the same audience. No existing bulk-notification
  -- function in this schema rate-limits itself; this is a new application
  -- of the established check_rate_limit primitive (0004_functions.sql:372).
  PERFORM public.check_rate_limit('event_announcement:' || p_event_id::text, 1, 900);

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  SELECT DISTINCT t.user_id, 'event_update', v_title, v_body, false, '📣',
         jsonb_build_object('eventId', p_event_id)
    FROM public.tickets t
   WHERE t.event_id = p_event_id
     AND t.status = 'active'
     AND t.payment_status = 'paid';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$function$
;

REVOKE ALL ON FUNCTION public.send_event_announcement(uuid, text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.send_event_announcement(uuid, text, text) TO authenticated, project_admin;
