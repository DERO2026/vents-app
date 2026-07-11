-- Offline-capable, cryptographically-signed ticket validation:
--  * tickets gains denormalized check-in columns (checked_in, checked_in_at,
--    scanner_id) so a single atomic UPDATE ... WHERE checked_in = false can
--    both assert-and-set entry status in one round trip (no TOCTOU gap).
--  * generate_ticket_token() mints an HMAC-SHA256-signed token for a ticket
--    (owner-only), so the QR can encode a signed string instead of a bare
--    UUID — verify_entry_pass() recomputes and checks the signature before
--    touching the row. Bare ticket_id is still accepted for backward
--    compatibility with tickets issued before this migration.
--  * verify_entry_pass() is the single atomic entry point for the scanner:
--    existence -> relational ownership (organizer must own the event) ->
--    not-already-checked-in -> atomic check-in write, all in one
--    SECURITY DEFINER call so the scanner never has to trust client-side
--    checks or make multiple round trips.

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS checked_in boolean NOT NULL DEFAULT false;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS scanner_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

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

  v_sig := encode(hmac(p_ticket_id::text, 'vents-ticket-hmac-v1', 'sha256'), 'hex');
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

  -- Accept either a bare UUID or an HMAC-signed "uuid.signature" token.
  IF strpos(p_ticket_id, '.') > 0 THEN
    v_raw_id := split_part(p_ticket_id, '.', 1);
    v_sig := split_part(p_ticket_id, '.', 2);
    v_expected_sig := encode(hmac(v_raw_id, 'vents-ticket-hmac-v1', 'sha256'), 'hex');
    IF v_sig IS DISTINCT FROM v_expected_sig THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_signature', 'message', 'This QR code failed cryptographic verification.');
    END IF;
  ELSE
    v_raw_id := p_ticket_id;
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
    -- Lost the race between the SELECT ... FOR UPDATE and this UPDATE.
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
