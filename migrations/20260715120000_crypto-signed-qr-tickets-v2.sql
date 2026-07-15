-- Enterprise-grade, cryptographically-signed QR ticket passes (v2).
--
-- WHAT CHANGED vs. the previous scheme:
--   * The old v1 token signed ONLY the bare ticket UUID (hmac(uuid)), carried
--     no event/purchaser binding, no issued/expiry timestamps, and no nonce.
--     Worse, its signing key was the literal string 'vents-ticket-hmac-v1'
--     committed in plaintext in this PUBLIC repository — anyone could read it
--     and forge a valid pass for any ticket UUID. v1 is now RETIRED.
--   * v2 signs a full, self-describing payload — ticketId, eventId,
--     purchaserId, issuedAt, expiresAt, nonce, version — with HMAC-SHA256 over
--     the entire base64url-encoded payload. Tampering with ANY field changes
--     the encoded payload and breaks the signature.
--   * The signing secret is now a 256-bit random value GENERATED IN THE
--     DATABASE (private.app_secrets) and never written to source control. It
--     lives in the `private` schema (not exposed by the REST API) with all
--     client-role grants revoked, so no API secret is ever reachable by the
--     client — only SECURITY DEFINER functions (running as the owner) read it.
--
-- TOKEN FORMAT (what the QR encodes):
--   "<base64url(payloadJson)>.<hexHmacSha256(base64url(payloadJson))>"
--   payloadJson = {"ticketId","eventId","purchaserId","issuedAt","expiresAt",
--                  "nonce","version":"2"}
--
-- verify_entry_pass remains the single atomic entry point for the scanner:
--   signature -> version -> expiry -> ticket lookup (FOR UPDATE) -> payload
--   binds to the real row -> organizer/admin authorization -> active status ->
--   not-already-scanned -> atomic conditional check-in write. Two gate staff
--   scanning the same pass simultaneously can never both succeed: the row is
--   locked with FOR UPDATE and the UPDATE only matches while checked_in=false.

-- ── 1. Server-only signing secret, out of source control ─────────────────────
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS private.app_secrets (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.app_secrets FROM PUBLIC;
REVOKE ALL ON private.app_secrets FROM anon, authenticated;

-- Generate a 256-bit random secret once, inside the database, so the value
-- never appears in this file or the git history. ON CONFLICT keeps it stable
-- across re-runs (rotating it would invalidate already-issued passes).
INSERT INTO private.app_secrets (key, value)
VALUES ('ticket_hmac_v2', encode(public.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- ── 2. Mint a v2 signed pass (owner-only) ────────────────────────────────────
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
    'nonce',       encode(public.gen_random_bytes(12), 'hex'),
    'version',     '2'
  );

  -- base64url(payloadJson): standard base64, strip Postgres' 76-col newlines,
  -- map +/ to -_ and drop = padding (URL-safe, JWT-style).
  v_encoded := rtrim(translate(replace(encode(convert_to(v_payload::text, 'UTF8'), 'base64'), chr(10), ''), '+/', '-_'), '=');
  v_sig := encode(public.hmac(v_encoded, v_secret, 'sha256'), 'hex');
  RETURN v_encoded || '.' || v_sig;
END;
$function$;

-- ── 3. Verify + atomically check in a scanned pass ───────────────────────────
CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid)
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
BEGIN
  -- Caller must be acting as their own authenticated identity.
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  -- Platform kill switch (app_config.disable_scanning).
  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  -- Abuse throttle.
  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  -- Structural: must be a "<payload>.<signature>" token.
  IF p_ticket_id IS NULL OR strpos(p_ticket_id, '.') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsigned_ticket',
      'message', 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (online) and rescan.');
  END IF;

  v_seg1 := split_part(p_ticket_id, '.', 1);
  v_seg2 := split_part(p_ticket_id, '.', 2);

  -- Retire the legacy v1 format (a bare "<uuid>.<sig>"). Its signing key
  -- shipped in the public git history, so v1 passes are no longer trusted —
  -- the attendee only needs to reopen their ticket online once to get a v2 pass.
  IF v_seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_token',
      'message', 'This pass uses an outdated format. Ask the attendee to reopen their ticket (online) to refresh it, then rescan.');
  END IF;

  -- Signature over the ENTIRE encoded payload, with the server-only secret.
  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket verification secret is not configured';
  END IF;

  v_expected_sig := encode(public.hmac(v_seg1, v_secret, 'sha256'), 'hex');
  IF v_seg2 IS DISTINCT FROM v_expected_sig THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_signature',
      'message', 'This QR code failed cryptographic verification.');
  END IF;

  -- Signature is valid → the payload is trustworthy. Decode it.
  BEGIN
    v_payload := convert_from(
      decode(translate(v_seg1, '-_', '+/') || repeat('=', (4 - length(v_seg1) % 4) % 4), 'base64'),
      'UTF8'
    )::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token',
      'message', 'This QR code could not be read.');
  END;

  IF (v_payload->>'version') IS DISTINCT FROM '2' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token',
      'message', 'Unsupported ticket version.');
  END IF;

  -- Expiry — a signed pass is only valid through the event window.
  IF (v_payload->>'expiresAt') IS NULL
     OR (v_payload->>'expiresAt')::timestamptz < now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired',
      'message', 'This ticket pass has expired.');
  END IF;

  v_raw_id := v_payload->>'ticketId';

  -- Load the ticket + event, locking the ticket row for an atomic check-in.
  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
      'message', 'Ticket not found in system.');
  END IF;

  -- Bind the signed payload to the real row: the signed eventId / purchaserId
  -- must match the ticket's actual event and buyer ("matches the current
  -- event"). A valid signature already guarantees this; the explicit check is
  -- defense-in-depth.
  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payload_mismatch',
      'message', 'This ticket pass does not match its event record.');
  END IF;

  -- Authorization: actor must own the event, or be Admin/Sub-Admin, or Root —
  -- covering the door on the real organizer's behalf. Ownership is checked
  -- against the ticket's real event.organizer_id, never a client value.
  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin()
     AND p_actor_id <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_organizer',
      'message', 'This ticket belongs to a different organizer''s event.');
  END IF;

  -- Active (rejects cancelled / refunded).
  IF v_ticket.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active',
      'message', 'This ticket is ' || v_ticket.status || ', not active.');
  END IF;

  -- Already used?
  IF v_ticket.checked_in THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id);
  END IF;

  -- ATOMIC check-in: conditional on still being unused. Combined with the
  -- FOR UPDATE lock above, two simultaneous scans can never both win.
  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.');
  END IF;

  INSERT INTO public.checkins (ticket_id, event_id, scanned_by, checked_in_at)
  VALUES (v_ticket.id, v_ticket.event_id, p_actor_id, now())
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
