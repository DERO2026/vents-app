-- Door Manager — Stage 1: immutable check-in ledger + door RPCs + realtime.
--
-- Builds ON TOP of the existing V2 cryptographic QR verification. The existing
-- public.checkins table already IS the immutable ledger:
--   * insert-only — no UPDATE policy exists for authenticated, so client rows
--     can never be mutated (immutability is enforced at the RLS layer; we do
--     NOT add a hard update/delete trigger because the table's FKs are
--     ON DELETE CASCADE and a blocking trigger would break event/ticket
--     deletion),
--   * UNIQUE(ticket_id) = duplicate-scan protection,
--   * organizer/owner-scoped SELECT RLS already in place.
-- We only ENRICH it with the fields the Door Manager needs and add the door
-- RPCs + realtime plumbing. verify_entry_pass keeps its single-transaction
-- atomicity (one SECURITY DEFINER call = one transaction covering both the
-- tickets.checked_in flip and the ledger insert).

-- ── 1. Enrich the immutable ledger ───────────────────────────────────────────
ALTER TABLE public.checkins
  ADD COLUMN IF NOT EXISTS user_id            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS device_id          text,
  ADD COLUMN IF NOT EXISTS gate_name          text,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_manual_override boolean NOT NULL DEFAULT false;

-- scanned_by (existing) is the "checked_in_by" actor. Backfill user_id (the
-- attendee) from the ticket for pre-existing ledger rows.
UPDATE public.checkins c
   SET user_id = t.user_id
  FROM public.tickets t
 WHERE t.id = c.ticket_id AND c.user_id IS NULL;

-- Performance: activity feed (recent-first per event) + checked_in_at range scans.
CREATE INDEX IF NOT EXISTS idx_checkins_event_checked_at ON public.checkins (event_id, checked_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_checked_in_at     ON public.checkins (checked_in_at);

-- ── 2. Internal helpers (not exposed as RPCs) ────────────────────────────────
-- Authorization: the event's real organizer, any Admin/Sub-Admin, or Root.
CREATE OR REPLACE FUNCTION public.is_event_door_manager(p_event_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.events e WHERE e.id = p_event_id AND e.organizer_id = auth.uid())
      OR public.is_admin()
      OR auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid;
$function$;
REVOKE ALL ON FUNCTION public.is_event_door_manager(uuid) FROM PUBLIC, anon, authenticated;

-- Live attendance snapshot for one event. "Sold" = active (non-refunded/
-- cancelled) tickets; "checked_in" uses the atomic tickets.checked_in flag.
CREATE OR REPLACE FUNCTION public.door_stats(p_event_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT jsonb_build_object(
    'total',          c.total,
    'checked_in',     c.checked_in,
    'remaining',      GREATEST(0, c.total - c.checked_in),
    'attendance_pct', CASE WHEN c.total > 0
                           THEN round(c.checked_in::numeric * 100 / c.total)::int
                           ELSE 0 END
  )
  FROM (
    SELECT count(*) FILTER (WHERE status = 'active')                      AS total,
           count(*) FILTER (WHERE status = 'active' AND checked_in)       AS checked_in
    FROM public.tickets WHERE event_id = p_event_id
  ) c;
$function$;
REVOKE ALL ON FUNCTION public.door_stats(uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. Extend verify_entry_pass: enrich ledger insert + return live totals ───
-- New optional params (device/gate) keep the existing 2-arg named RPC call
-- working unchanged. DROP first because CREATE OR REPLACE can't widen the
-- argument list.
DROP FUNCTION IF EXISTS public.verify_entry_pass(text, uuid);

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
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  IF p_ticket_id IS NULL OR strpos(p_ticket_id, '.') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsigned_ticket',
      'message', 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (online) and rescan.');
  END IF;

  v_seg1 := split_part(p_ticket_id, '.', 1);
  v_seg2 := split_part(p_ticket_id, '.', 2);

  IF v_seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'legacy_token',
      'message', 'This pass uses an outdated format. Ask the attendee to reopen their ticket (online) to refresh it, then rescan.');
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket verification secret is not configured';
  END IF;

  v_expected_sig := encode(public.hmac(v_seg1, v_secret, 'sha256'), 'hex');
  IF v_seg2 IS DISTINCT FROM v_expected_sig THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_signature',
      'message', 'This QR code failed cryptographic verification.');
  END IF;

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

  IF (v_payload->>'expiresAt') IS NULL
     OR (v_payload->>'expiresAt')::timestamptz < now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired',
      'message', 'This ticket pass has expired.');
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
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
      'message', 'Ticket not found in system.');
  END IF;

  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payload_mismatch',
      'message', 'This ticket pass does not match its event record.');
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin()
     AND p_actor_id <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_organizer',
      'message', 'This ticket belongs to a different organizer''s event.');
  END IF;

  IF v_ticket.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active',
      'message', 'This ticket is ' || v_ticket.status || ', not active.');
  END IF;

  IF v_ticket.checked_in THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  -- ATOMIC check-in: the tickets flag and the ledger row commit together.
  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, false)
  ON CONFLICT (ticket_id) DO NOTHING;

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

-- ── 4. Manual check-in (dead-phone override) ─────────────────────────────────
-- Same atomic ticket-flag + ledger-insert transaction, but bypasses the QR
-- signature (no token) and flags is_manual_override = true for the audit trail.
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
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'Ticket not found in system.');
  END IF;

  IF NOT public.is_event_door_manager(v_ticket.event_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_organizer',
      'message', 'This ticket belongs to a different organizer''s event.');
  END IF;

  IF v_ticket.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active',
      'message', 'This ticket is ' || v_ticket.status || ', not active.');
  END IF;

  IF v_ticket.checked_in THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, true)
  ON CONFLICT (ticket_id) DO NOTHING;

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

-- ── 5. Read RPCs for the dashboard (gated; single-query, no N+1) ──────────────
CREATE OR REPLACE FUNCTION public.get_door_stats(p_event_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;
  RETURN public.door_stats(p_event_id);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_door_stats(uuid) TO authenticated;

-- Paginated, filterable, searchable attendee roster in ONE query (ticket +
-- ledger + buyer profile joined), so the guest list never N+1s.
CREATE OR REPLACE FUNCTION public.get_event_attendees(
  p_event_id uuid,
  p_search   text DEFAULT NULL,
  p_filter   text DEFAULT 'all',
  p_limit    int  DEFAULT 50,
  p_offset   int  DEFAULT 0
)
 RETURNS TABLE(
  ticket_id uuid, holder_name text, holder_email text, buyer_phone text,
  ticket_type text, status text, payment_status text, amount numeric,
  checked_in boolean, checked_in_at timestamptz, is_manual_override boolean,
  gate_name text, purchased_at timestamptz, order_ref text,
  user_id uuid, buyer_name text, avatar_url text
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_q text := NULLIF(trim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT t.id, t.holder_name, t.holder_email, u.phone_number,
         t.ticket_type, t.status, t.payment_status, t.amount,
         t.checked_in, t.checked_in_at, COALESCE(ci.is_manual_override, false),
         ci.gate_name, t.created_at, t.payment_ref,
         t.user_id, u.full_name, u.avatar_url
  FROM public.tickets t
  LEFT JOIN public.checkins ci ON ci.ticket_id = t.id
  LEFT JOIN public.users u     ON u.id = t.user_id
  WHERE t.event_id = p_event_id
    AND (
      p_filter = 'all'
      OR (p_filter = 'checked_in' AND t.checked_in)
      OR (p_filter = 'pending'    AND t.status = 'active' AND NOT t.checked_in)
      OR (p_filter = 'vip'        AND t.ticket_type ILIKE '%vip%')
      OR (p_filter = 'regular'    AND t.ticket_type NOT ILIKE '%vip%')
      OR (p_filter = 'refunded'   AND t.status = 'refunded')
      OR (p_filter = 'cancelled'  AND t.status = 'cancelled')
    )
    AND (
      v_q IS NULL
      OR t.holder_name  ILIKE '%' || v_q || '%'
      OR t.holder_email ILIKE '%' || v_q || '%'
      OR u.phone_number ILIKE '%' || v_q || '%'
      OR u.full_name    ILIKE '%' || v_q || '%'
      OR t.id::text = v_q
    )
  ORDER BY t.checked_in_at DESC NULLS LAST, t.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200))
  OFFSET GREATEST(0, p_offset);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_event_attendees(uuid, text, text, int, int) TO authenticated;

-- Recent check-ins for the live activity feed (newest first).
CREATE OR REPLACE FUNCTION public.get_recent_checkins(p_event_id uuid, p_limit int DEFAULT 25)
 RETURNS TABLE(
  checkin_id uuid, ticket_id uuid, holder_name text, ticket_type text,
  checked_in_at timestamptz, gate_name text, is_manual_override boolean,
  scanned_by uuid, scanner_name text
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT ci.id, ci.ticket_id, t.holder_name, t.ticket_type,
         ci.checked_in_at, ci.gate_name, ci.is_manual_override,
         ci.scanned_by, su.full_name
  FROM public.checkins ci
  JOIN public.tickets t  ON t.id = ci.ticket_id
  LEFT JOIN public.users su ON su.id = ci.scanned_by
  WHERE ci.event_id = p_event_id
  ORDER BY ci.checked_in_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_recent_checkins(uuid, int) TO authenticated;

-- ── 6. Realtime: per-event door channel + PII-free change broadcasts ──────────
-- Register the wildcard channel. The existing realtime.channels RLS policy
-- (realtime_channels_admin_stats_gate) already permits every pattern except
-- 'admin:stats', so 'door:%' is subscribable by authenticated clients. The
-- broadcast payloads below deliberately carry NO attendee PII — only ids and
-- flags — so the channel is a "refetch" signal; all real data stays behind the
-- gated RPCs / RLS above.
INSERT INTO realtime.channels (pattern, description, enabled)
VALUES ('door:%', 'Live door check-in updates, per event', true)
ON CONFLICT (pattern) DO UPDATE
  SET description = EXCLUDED.description, enabled = EXCLUDED.enabled;

CREATE OR REPLACE FUNCTION public.notify_door_checkin()
RETURNS TRIGGER AS $function$
BEGIN
  PERFORM realtime.publish(
    'door:' || NEW.event_id::text,
    'checkin',
    jsonb_build_object(
      'checkin_id', NEW.id,
      'ticket_id', NEW.ticket_id,
      'is_manual_override', NEW.is_manual_override,
      'checked_in_at', NEW.checked_in_at
    )
  );
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_door_checkin ON public.checkins;
CREATE TRIGGER trg_door_checkin
AFTER INSERT ON public.checkins
FOR EACH ROW EXECUTE FUNCTION public.notify_door_checkin();

-- Ticket sales / refunds / cancellations move the "sold" and "remaining"
-- totals; publish on those so the dashboard refetches stats. (checked_in
-- changes are covered by the checkins trigger above, so they're excluded here
-- to avoid a double broadcast per scan.)
CREATE OR REPLACE FUNCTION public.notify_door_ticket()
RETURNS TRIGGER AS $function$
BEGIN
  PERFORM realtime.publish(
    'door:' || NEW.event_id::text,
    'ticket',
    jsonb_build_object('ticket_id', NEW.id, 'status', NEW.status)
  );
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_door_ticket ON public.tickets;
CREATE TRIGGER trg_door_ticket
AFTER INSERT OR UPDATE OF status, payment_status ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.notify_door_ticket();
