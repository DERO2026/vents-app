-- CRITICAL FIX — hmac() was never resolvable inside generate_ticket_token /
-- verify_entry_pass. Both functions run with SET search_path TO '' (correct
-- hardening against search_path injection), but that also means an
-- unqualified call to hmac() can never find pgcrypto's function, which is
-- installed in the public schema. Every call to generate_ticket_token has
-- been failing silently (caught by the frontend's error handler, which
-- falls back to displaying the bare ticket_id) since the feature was first
-- introduced — this was masked until today's fix made verify_entry_pass
-- strictly reject bare/unsigned ticket IDs, which turned a silent
-- degradation into a hard failure for every real ticket.
--
-- Fix: schema-qualify every hmac() call as public.hmac().

CREATE OR REPLACE FUNCTION public.generate_ticket_token(p_ticket_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner uuid;
  v_sig text;
BEGIN
  SELECT user_id INTO v_owner FROM public.tickets WHERE id = p_ticket_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Not authorized to sign this ticket';
  END IF;

  v_sig := encode(public.hmac(p_ticket_id::text, 'vents-ticket-hmac-v1', 'sha256'), 'hex');
  RETURN p_ticket_id::text || '.' || v_sig;
END;
$function$;

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
  v_expected_sig := encode(public.hmac(v_raw_id, 'vents-ticket-hmac-v1', 'sha256'), 'hex');
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
