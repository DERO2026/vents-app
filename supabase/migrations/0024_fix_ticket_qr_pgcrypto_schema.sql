-- Fixes generate_ticket_token() and verify_entry_pass(), found live while
-- transferring the ticket QR HMAC secret: both call public.gen_random_bytes()
-- / public.hmac() (pgcrypto functions), but on this Supabase project
-- pgcrypto is installed in the "extensions" schema, not "public" - InsForge
-- evidently made pgcrypto available under public, so the original functions
-- worked there unmodified. With SET search_path TO '' (used throughout this
-- migration for security) the bare "public.gen_random_bytes(...)" call
-- fails outright ("function public.gen_random_bytes(integer) does not
-- exist"), which would have made every QR ticket generation and every
-- door scan fail immediately once traffic moved to Supabase - independent
-- of the secret-transfer work itself. Schema-qualified to extensions.*;
-- no other behavior change.

CREATE OR REPLACE FUNCTION public.generate_ticket_token(p_ticket_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner      uuid;
  v_event_id   uuid;
  v_event_date timestamptz;
  v_secret     text;
  v_expires    timestamptz;
  v_payload    jsonb;
  v_encoded    text;
  v_sig        text;
BEGIN
  SELECT t.user_id, t.event_id, e.event_date
    INTO v_owner, v_event_id, v_event_date
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Not authorized to sign this ticket';
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket signing secret is not configured';
  END IF;

  -- Valid through the event day + a 2-day grace (late entry / after-parties),
  -- floored at now()+2d so a pass minted for a past-dated or undated event is
  -- never already-expired the instant it is issued.
  v_expires := GREATEST(COALESCE(v_event_date, now()) + interval '2 days', now() + interval '2 days');

  v_payload := jsonb_build_object(
    'ticketId',    p_ticket_id::text,
    'eventId',     v_event_id::text,
    'purchaserId', v_owner::text,
    'issuedAt',    to_char(now()     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'expiresAt',   to_char(v_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'nonce',       encode(extensions.gen_random_bytes(12), 'hex'),
    'version',     '2'
  );

  -- base64url(payloadJson): standard base64, strip Postgres' 76-col newlines,
  -- map +/ to -_ and drop = padding (URL-safe, JWT-style).
  v_encoded := rtrim(translate(replace(encode(convert_to(v_payload::text, 'UTF8'), 'base64'), chr(10), ''), '+/', '-_'), '=');
  v_sig := encode(extensions.hmac(v_encoded, v_secret, 'sha256'), 'hex');
  RETURN v_encoded || '.' || v_sig;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_secret       text;
  v_seg1         text;
  v_seg2         text;
  v_expected_sig text;
  v_payload      jsonb;
  v_raw_id       text;
  v_ticket       record;
  v_log_event_id uuid;
  v_reason       text;
  v_message      text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  IF p_ticket_id IS NULL OR strpos(p_ticket_id, '.') = 0 THEN
    v_reason := 'unsigned_ticket';
    v_message := 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (online) and rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_seg1 := split_part(p_ticket_id, '.', 1);
  v_seg2 := split_part(p_ticket_id, '.', 2);

  IF v_seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_reason := 'legacy_token';
    v_message := 'This pass uses an outdated format. Ask the attendee to reopen their ticket (online) to refresh it, then rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket verification secret is not configured';
  END IF;

  v_expected_sig := encode(extensions.hmac(v_seg1, v_secret, 'sha256'), 'hex');
  IF v_seg2 IS DISTINCT FROM v_expected_sig THEN
    v_reason := 'invalid_signature';
    v_message := 'This QR code failed cryptographic verification.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  BEGIN
    v_payload := convert_from(
      decode(translate(v_seg1, '-_', '+/') || repeat('=', (4 - length(v_seg1) % 4) % 4), 'base64'),
      'UTF8'
    )::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_reason := 'invalid_token';
    v_message := 'This QR code could not be read.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END;

  -- From here on the payload is readable, so its eventId (unverified against
  -- the ticket yet, but still the attendee's claimed event) lets us attribute
  -- the log entry to the right event's dashboard even when the check below
  -- fails before a ticket row is loaded.
  BEGIN
    v_log_event_id := (v_payload->>'eventId')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_log_event_id := NULL;
  END;

  IF (v_payload->>'version') IS DISTINCT FROM '2' THEN
    v_reason := 'invalid_token';
    v_message := 'Unsupported ticket version.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF (v_payload->>'expiresAt') IS NULL
     OR (v_payload->>'expiresAt')::timestamptz < now() THEN
    v_reason := 'expired';
    v_message := 'This ticket pass has expired.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_raw_id := v_payload->>'ticketId';

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found';
    v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  -- Now that the real ticket is loaded, prefer its authoritative event_id for
  -- logging over the unverified payload claim.
  v_log_event_id := v_ticket.event_id;

  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    v_reason := 'payload_mismatch';
    v_message := 'This ticket pass does not match its event record.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin()
     AND p_actor_id <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    v_reason := 'wrong_organizer';
    v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active';
    v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  -- ATOMIC check-in: the tickets flag, the ledger row, and the scan log all
  -- commit together in this one SECURITY DEFINER call's transaction. The
  -- `WHERE checked_in = false` re-check + ON CONFLICT DO NOTHING below is what
  -- actually makes a race between two simultaneous scans of the same ticket
  -- safe -- the FOR UPDATE row lock above already serializes concurrent
  -- scanners against this same ticket row, so only one commits the flip.
  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, false)
  ON CONFLICT (ticket_id) DO NOTHING;

  PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, false);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', false,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;
