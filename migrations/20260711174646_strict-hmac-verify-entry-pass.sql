-- CRITICAL SECURITY FIX — close the HMAC bypass in verify_entry_pass.
--
-- Previously a bare, unsigned ticket UUID (no HMAC suffix) was accepted
-- outright as a valid credential — the signature check only ran when the
-- scanned string happened to contain a '.'. Since QRTicket.tsx also leaked
-- the plaintext ticket_id via share text, the downloaded PNG, and the
-- visible caption under the QR, anyone who obtained just that plaintext ID
-- (screenshot, forwarded message) had a fully valid, unsigned "credential".
--
-- Fix: a bare/unsigned ticket_id is now explicitly rejected. Only a
-- correctly-signed "ticket_id.signature" token is accepted.
CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_organizer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_raw_id text;
  v_sig text;
  v_expected_sig text;
  v_ticket record;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_organizer_id THEN
    RAISE EXCEPTION 'Not authorized to scan on behalf of this organizer';
  END IF;

  IF strpos(p_ticket_id, '.') = 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'unsigned_ticket',
      'message', 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (with an internet connection, at least once) and rescan.'
    );
  END IF;

  v_raw_id := split_part(p_ticket_id, '.', 1);
  v_sig := split_part(p_ticket_id, '.', 2);
  v_expected_sig := encode(hmac(v_raw_id, 'vents-ticket-hmac-v1', 'sha256'), 'hex');
  IF v_sig IS DISTINCT FROM v_expected_sig THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_signature', 'message', 'This QR code failed cryptographic verification.');
  END IF;

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title, e.event_date
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'Ticket not found in system.');
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_organizer_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_organizer', 'message', 'This ticket belongs to a different organizer''s event.');
  END IF;

  IF v_ticket.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active', 'message', 'This ticket is ' || v_ticket.status || ', not active.');
  END IF;

  IF v_ticket.checked_in THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at,
      'scanner_id', v_ticket.scanner_id
    );
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_organizer_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned', 'message', 'This ticket was already scanned.');
  END IF;

  INSERT INTO public.checkins (ticket_id, event_id, scanned_by, checked_in_at)
  VALUES (v_ticket.id, v_ticket.event_id, p_organizer_id, now())
  ON CONFLICT (ticket_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now()
  );
END;
$function$;
