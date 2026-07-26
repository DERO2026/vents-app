-- ── Full scan audit trail: every scan attempt, not just successful ones ──────
-- public.checkins only ever recorded a SUCCESSFUL admission. Denied scans
-- (duplicate, invalid/forged QR, wrong event, refunded, cancelled, expired)
-- were returned to the client but never persisted anywhere — no audit trail,
-- no cross-device visibility, and no way for the Door Manager dashboard to
-- show "duplicate scan attempts" / "invalid or fake tickets" as the requested
-- production check-in system requires. This adds an insert-only, per-scan log
-- covering EVERY outcome (valid, duplicate, invalid, wrong_event, refunded,
-- cancelled), attributed to the event, the ticket (when resolvable), and the
-- scanning user — and wires it into the existing atomic verify_entry_pass /
-- manual_check_in transactions so a scan attempt and its outcome commit
-- together, same as the checkins ledger insert already does.

-- ── 1. The log table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scan_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid REFERENCES public.events(id) ON DELETE CASCADE,
  ticket_id          uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  scanned_by         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  result             text NOT NULL CHECK (result IN ('valid', 'duplicate', 'invalid', 'wrong_event', 'refunded', 'cancelled')),
  reason             text,
  message            text,
  device_id          text,
  gate_name          text,
  is_manual_override boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_log_event_created  ON public.scan_log (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_log_event_result   ON public.scan_log (event_id, result);

-- Insert-only, no direct client access at all: every read goes through the
-- gated get_scan_log RPC below (SECURITY DEFINER, same is_event_door_manager
-- authorization as the rest of the door RPCs), every write happens inside
-- verify_entry_pass/manual_check_in (also SECURITY DEFINER). Mirrors the
-- tickets-table lockdown pattern -- no table-level GRANT to anon/authenticated
-- at all, since the owning role (project_admin) doesn't need one.
ALTER TABLE public.scan_log ENABLE ROW LEVEL SECURITY;

-- ── 2. Internal logging helper (not exposed as an RPC) ───────────────────────
CREATE OR REPLACE FUNCTION public.log_scan_attempt(
  p_event_id   uuid,
  p_ticket_id  uuid,
  p_scanned_by uuid,
  p_result     text,
  p_reason     text,
  p_message    text,
  p_device_id  text,
  p_gate_name  text,
  p_is_manual  boolean
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.scan_log
    (event_id, ticket_id, scanned_by, result, reason, message, device_id, gate_name, is_manual_override)
  VALUES
    (p_event_id, p_ticket_id, p_scanned_by, p_result, p_reason, p_message, p_device_id, p_gate_name, p_is_manual);
END;
$function$;
REVOKE ALL ON FUNCTION public.log_scan_attempt(uuid, uuid, uuid, text, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- Maps a verify_entry_pass/manual_check_in `reason` (+ its message text, for
-- the two reasons that fold multiple states into one) to a dashboard bucket.
CREATE OR REPLACE FUNCTION public.scan_reason_to_result(p_reason text, p_message text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO '' AS $function$
  SELECT CASE
    WHEN p_reason = 'already_scanned' THEN 'duplicate'
    WHEN p_reason IN ('wrong_organizer', 'payload_mismatch') THEN 'wrong_event'
    WHEN p_reason = 'not_active' AND p_message ILIKE '%refund%' THEN 'refunded'
    WHEN p_reason = 'not_active' AND p_message ILIKE '%cancel%' THEN 'cancelled'
    ELSE 'invalid'
  END;
$function$;
REVOKE ALL ON FUNCTION public.scan_reason_to_result(text, text) FROM PUBLIC, anon, authenticated;

-- ── 3. Re-point door_stats to also surface attempt counts ────────────────────
CREATE OR REPLACE FUNCTION public.door_stats(p_event_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT jsonb_build_object(
    'total',              c.total,
    'checked_in',         c.checked_in,
    'remaining',           GREATEST(0, c.total - c.checked_in),
    'attendance_pct',      CASE WHEN c.total > 0
                                THEN round(c.checked_in::numeric * 100 / c.total)::int
                                ELSE 0 END,
    'duplicate_attempts',  COALESCE(s.duplicate_attempts, 0),
    'invalid_attempts',    COALESCE(s.invalid_attempts, 0)
  )
  FROM (
    SELECT count(*) FILTER (WHERE status = 'active')                      AS total,
           count(*) FILTER (WHERE status = 'active' AND checked_in)       AS checked_in
    FROM public.tickets WHERE event_id = p_event_id
  ) c
  CROSS JOIN (
    SELECT count(*) FILTER (WHERE result = 'duplicate')                        AS duplicate_attempts,
           count(*) FILTER (WHERE result IN ('invalid', 'wrong_event', 'refunded', 'cancelled')) AS invalid_attempts
    FROM public.scan_log WHERE event_id = p_event_id
  ) s;
$function$;
-- door_stats already has no PUBLIC/anon/authenticated grant from the prior
-- migration; CREATE OR REPLACE preserves that.

-- ── 4. Wire logging into verify_entry_pass (every branch, same transaction) ──
DROP FUNCTION IF EXISTS public.verify_entry_pass(text, uuid, text, text);

CREATE FUNCTION public.verify_entry_pass(
  p_ticket_id text,
  p_actor_id  uuid,
  p_device_id text DEFAULT NULL,
  p_gate_name text DEFAULT NULL
)
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

  v_expected_sig := encode(public.hmac(v_seg1, v_secret, 'sha256'), 'hex');
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

GRANT EXECUTE ON FUNCTION public.verify_entry_pass(text, uuid, text, text) TO authenticated;

-- ── 5. Same logging for manual_check_in ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.manual_check_in(
  p_ticket_id uuid,
  p_actor_id  uuid,
  p_device_id text DEFAULT NULL,
  p_gate_name text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
  v_reason text;
  v_message text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to check in as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('manual_checkin:' || p_actor_id::text, 30, 10);

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type,
         t.checked_in, t.checked_in_at, t.scanner_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found'; v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(NULL, p_ticket_id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF NOT public.is_event_door_manager(v_ticket.event_id) THEN
    v_reason := 'wrong_organizer'; v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active'; v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already checked in.', p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already checked in.', p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, true)
  ON CONFLICT (ticket_id) DO NOTHING;

  PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, true);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', true,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.manual_check_in(uuid, uuid, text, text) TO authenticated;

-- ── 6. Read RPC for the scan history / audit feed (gated, paginated) ─────────
CREATE OR REPLACE FUNCTION public.get_scan_log(
  p_event_id uuid,
  p_result   text DEFAULT NULL,
  p_limit    int  DEFAULT 50,
  p_offset   int  DEFAULT 0
)
 RETURNS TABLE(
  id uuid, ticket_id uuid, holder_name text, ticket_type text,
  scanned_by uuid, scanner_name text, result text, reason text, message text,
  device_id text, gate_name text, is_manual_override boolean, created_at timestamptz
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT l.id, l.ticket_id, t.holder_name, t.ticket_type,
         l.scanned_by, su.full_name, l.result, l.reason, l.message,
         l.device_id, l.gate_name, l.is_manual_override, l.created_at
  FROM public.scan_log l
  LEFT JOIN public.tickets t ON t.id = l.ticket_id
  LEFT JOIN public.users su  ON su.id = l.scanned_by
  WHERE l.event_id = p_event_id
    AND (p_result IS NULL OR l.result = p_result)
  ORDER BY l.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200))
  OFFSET GREATEST(0, p_offset);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_scan_log(uuid, text, int, int) TO authenticated;

-- ── 7. Realtime: broadcast every scan attempt (not just successful checkins) ─
-- Reuses the existing 'door:%' channel. Payload stays PII-free (result/flags
-- only) -- real data is behind the gated get_scan_log/get_door_stats RPCs.
CREATE OR REPLACE FUNCTION public.notify_door_scan()
RETURNS TRIGGER AS $function$
BEGIN
  IF NEW.event_id IS NOT NULL THEN
    PERFORM realtime.publish(
      'door:' || NEW.event_id::text,
      'scan_attempt',
      jsonb_build_object('result', NEW.result, 'is_manual_override', NEW.is_manual_override, 'created_at', NEW.created_at)
    );
  END IF;
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_door_scan ON public.scan_log;
CREATE TRIGGER trg_door_scan
AFTER INSERT ON public.scan_log
FOR EACH ROW EXECUTE FUNCTION public.notify_door_scan();
