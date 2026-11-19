-- Local-only test schema for the ticket purchase / QR / check-in path
-- (scripts/local-pg-test/run-ticket-integrity-verification.sh). Loaded on top
-- of the shared local money stack. Every function below is a VERBATIM copy of
-- the latest repository definition (file named above each one); the tables
-- and secret are the minimum those functions need. award_vc_reward is a
-- no-op stub: VENTS Cents accounting is not under test here.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.app_secrets (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO private.app_secrets (key, value) VALUES ('ticket_hmac_v2', 'local-test-secret-not-a-real-key')
  ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.scan_log (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, event_id uuid, ticket_id uuid, scanned_by uuid,
  result text NOT NULL CHECK (result = ANY (ARRAY['valid','duplicate','invalid','wrong_event','refunded','cancelled'])),
  reason text, message text, device_id text, gate_name text, is_manual_override boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.app_config ADD COLUMN IF NOT EXISTS disable_scanning boolean NOT NULL DEFAULT false;
INSERT INTO public.app_config SELECT WHERE NOT EXISTS (SELECT 1 FROM public.app_config);  -- shape differs between local stacks
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS scanner_id uuid;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS holder_email text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS holder_phone text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS promo_code text;
CREATE TABLE IF NOT EXISTS public.promo_codes (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, code text NOT NULL, discount_percentage numeric NOT NULL,
  max_uses integer, current_uses integer NOT NULL DEFAULT 0, expires_at timestamptz, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.checkins (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, ticket_id uuid NOT NULL UNIQUE, event_id uuid NOT NULL, scanned_by uuid,
  checked_in_at timestamptz NOT NULL DEFAULT now(), user_id uuid, device_id text, gate_name text, created_at timestamptz NOT NULL DEFAULT now(),
  is_manual_override boolean NOT NULL DEFAULT false);
-- The shared local stack may already have a narrower checkins table: complete it.
ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS gate_name text;
ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS scanned_by uuid;
ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS checked_in_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.checkins ADD COLUMN IF NOT EXISTS is_manual_override boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS checkins_ticket_id_key_local ON public.checkins (ticket_id);
CREATE TABLE IF NOT EXISTS public.vc_transactions (user_id uuid, reference_id uuid, campaign_key text, type text, status text);
DO $stub$
BEGIN
  IF to_regprocedure('public.award_vc_reward(uuid,text,uuid,text)') IS NULL THEN
    CREATE FUNCTION public.award_vc_reward(p_user_id uuid, p_campaign_key text, p_reference_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'active'::text)
     RETURNS void LANGUAGE sql AS $f$ SELECT NULL::void $f$;
  END IF;
END
$stub$;

-- 0004_functions.sql
CREATE OR REPLACE FUNCTION public.log_scan_attempt(p_event_id uuid, p_ticket_id uuid, p_scanned_by uuid, p_result text, p_reason text, p_message text, p_device_id text, p_gate_name text, p_is_manual boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.scan_log
    (event_id, ticket_id, scanned_by, result, reason, message, device_id, gate_name, is_manual_override)
  VALUES
    (p_event_id, p_ticket_id, p_scanned_by, p_result, p_reason, p_message, p_device_id, p_gate_name, p_is_manual);
END;
$function$;


-- 0004_functions.sql
CREATE OR REPLACE FUNCTION public.door_stats(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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


-- 0004_functions.sql
CREATE OR REPLACE FUNCTION public.scan_reason_to_result(p_reason text, p_message text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_reason = 'already_scanned' THEN 'duplicate'
    WHEN p_reason IN ('wrong_organizer', 'payload_mismatch') THEN 'wrong_event'
    WHEN p_reason = 'not_active' AND p_message ILIKE '%refund%' THEN 'refunded'
    WHEN p_reason = 'not_active' AND p_message ILIKE '%cancel%' THEN 'cancelled'
    ELSE 'invalid'
  END;
$function$;


-- 0104_remove_redundant_root_uid_and_anon_execute.sql
CREATE OR REPLACE FUNCTION public.is_event_door_manager(p_event_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.events e WHERE e.id = p_event_id AND e.organizer_id = auth.uid())
      OR public.is_admin();
$function$;


-- 0024_fix_ticket_qr_pgcrypto_schema.sql
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


-- 0124_emergency_kill_switches.sql
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id       uuid := auth.uid();
  v_event         record;
  v_ticket_obj    jsonb;
  v_unit_price    numeric;
  v_discount_pct  numeric := 0;
  v_effective     numeric;
  v_status        text;
  v_attendee      jsonb;
  v_ticket_id     uuid;
  v_ticket_ids    uuid[] := ARRAY[]::uuid[];
  v_count         integer;
  v_promo         public.promo_codes;
  v_existing_ids  uuid[];
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
BEGIN
  IF public.purchases_disabled() THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  SELECT array_agg(id) INTO v_existing_ids
  FROM public.tickets
  WHERE event_id = p_event_id AND user_id = v_user_id AND payment_ref = p_payment_ref AND status = 'active';

  IF v_existing_ids IS NOT NULL THEN
    RETURN v_existing_ids;
  END IF;

  SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, hidden_by_admin
  INTO v_event
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF v_event.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event has been removed and is no longer accepting purchases';
  END IF;

  IF v_event.status <> 'live' THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;

  IF v_event.hidden_by_admin THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;

  IF v_event.event_date::date < current_date THEN
    RAISE EXCEPTION 'This event has already ended';
  END IF;

  IF v_event.ticket_types IS NOT NULL AND jsonb_array_length(v_event.ticket_types) > 0 THEN
    SELECT tt INTO v_ticket_obj
    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;

    IF v_ticket_obj IS NULL THEN
      RAISE EXCEPTION 'Ticket type not found';
    END IF;

    v_unit_price := (v_ticket_obj->>'price')::numeric;
  ELSE
    v_unit_price := COALESCE(v_event.price, 0);
  END IF;

  IF v_unit_price IS NULL OR v_unit_price < 0 THEN
    RAISE EXCEPTION 'This ticket type has an invalid price and cannot be purchased';
  END IF;

  IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
    SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = p_event_id AND status = 'active';
    IF v_event_sold + v_count > v_event.ticket_goal THEN
      RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
    END IF;
  END IF;

  IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
    v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
    IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
      SELECT count(*) INTO v_type_sold
      FROM public.tickets
      WHERE event_id = p_event_id AND ticket_type = p_ticket_type AND status = 'active';

      IF v_type_sold + v_count > v_type_limit THEN
        RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), p_ticket_type;
      END IF;
    END IF;
  END IF;

  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_promo_code));

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid promo code';
    END IF;
    IF NOT v_promo.is_active THEN
      RAISE EXCEPTION 'This promo code is no longer active';
    END IF;
    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
      RAISE EXCEPTION 'This promo code has expired';
    END IF;
    IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
      RAISE EXCEPTION 'This promo code has reached its usage limit';
    END IF;

    v_discount_pct := v_promo.discount_percentage;
  END IF;

  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

  FOR v_attendee IN SELECT * FROM jsonb_array_elements(p_attendees)
  LOOP
    IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each attendee must have a name';
    END IF;

    INSERT INTO public.tickets
      (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
       holder_name, holder_email, holder_phone, promo_code, discount_percentage)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''), NULLIF(trim(v_attendee->>'phone'), ''),
       CASE WHEN v_promo.id IS NOT NULL THEN upper(trim(p_promo_code)) ELSE NULL END, v_discount_pct)
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
  END LOOP;

  IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
  END IF;

  RETURN v_ticket_ids;
END;
$function$;


-- 0004_functions.sql
CREATE OR REPLACE FUNCTION public.purchase_ticket_with_tokens(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ids uuid[];
  v_id uuid;
  v_result jsonb := '[]'::jsonb;
BEGIN
  -- Reuse the audited, idempotent purchase path exactly as-is.
  v_ids := public.purchase_ticket(p_event_id, p_ticket_type, p_attendees, p_payment_ref, p_promo_code);

  IF v_ids IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Sign each freshly-created ticket in the same transaction (the rows are
  -- already visible here), returning {ticket_id, token} pairs.
  FOREACH v_id IN ARRAY v_ids LOOP
    v_result := v_result || jsonb_build_object(
      'ticket_id', v_id,
      'token', public.generate_ticket_token(v_id)
    );
  END LOOP;

  RETURN v_result;
END;
$function$;


-- 0147_vc_system_pool_and_admin_credit_lifetime_reconciliation.sql
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
  v_is_first_qualifying_checkin boolean;
  v_referrer_id  uuid;
  v_vc_eligible  boolean;
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

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
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

  v_log_event_id := v_ticket.event_id;

  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    v_reason := 'payload_mismatch';
    v_message := 'This ticket pass does not match its event record.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin() THEN
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

  v_vc_eligible := COALESCE(v_ticket.amount, 0) >= 20000;

  IF v_vc_eligible THEN
    PERFORM public.award_vc_reward(v_ticket.user_id, 'event_checkin', v_ticket.id, 'active');

    -- Batch C: referrer first-*qualifying*-check-in reward.
    SELECT (count(*) = 1) INTO v_is_first_qualifying_checkin
      FROM public.checkins c
      JOIN public.tickets t2 ON t2.id = c.ticket_id
     WHERE c.user_id = v_ticket.user_id AND COALESCE(t2.amount, 0) >= 20000;

    IF v_is_first_qualifying_checkin THEN
      SELECT reference_id INTO v_referrer_id FROM public.vc_transactions
       WHERE user_id = v_ticket.user_id AND campaign_key = 'referral_referred' AND type = 'earn' AND status = 'active'
       LIMIT 1;
      IF v_referrer_id IS NOT NULL THEN
        PERFORM public.award_vc_reward(v_referrer_id, 'referral_referrer_checkin', v_ticket.user_id, 'active');
      END IF;
    END IF;
  END IF;

  PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, false);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', false,
    'vc_awarded', v_vc_eligible,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;


-- 0147_vc_system_pool_and_admin_credit_lifetime_reconciliation.sql
CREATE OR REPLACE FUNCTION public.manual_check_in(p_ticket_id uuid, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
  v_reason text;
  v_message text;
  v_is_first_qualifying_checkin boolean;
  v_referrer_id uuid;
  v_vc_eligible boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to check in as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('manual_checkin:' || p_actor_id::text, 30, 10);

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type, t.amount,
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

  v_vc_eligible := COALESCE(v_ticket.amount, 0) >= 20000;

  IF v_vc_eligible THEN
    PERFORM public.award_vc_reward(v_ticket.user_id, 'event_checkin', v_ticket.id, 'active');

    -- Batch C: referrer first-*qualifying*-check-in reward.
    SELECT (count(*) = 1) INTO v_is_first_qualifying_checkin
      FROM public.checkins c
      JOIN public.tickets t2 ON t2.id = c.ticket_id
     WHERE c.user_id = v_ticket.user_id AND COALESCE(t2.amount, 0) >= 20000;

    IF v_is_first_qualifying_checkin THEN
      SELECT reference_id INTO v_referrer_id FROM public.vc_transactions
       WHERE user_id = v_ticket.user_id AND campaign_key = 'referral_referred' AND type = 'earn' AND status = 'active'
       LIMIT 1;
      IF v_referrer_id IS NOT NULL THEN
        PERFORM public.award_vc_reward(v_referrer_id, 'referral_referrer_checkin', v_ticket.user_id, 'active');
      END IF;
    END IF;
  END IF;

  PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, true);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', true,
    'vc_awarded', v_vc_eligible,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$;

