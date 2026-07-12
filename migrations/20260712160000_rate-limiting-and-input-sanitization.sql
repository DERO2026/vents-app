-- Phase 3 (Abuse Prevention): DB-enforced rate limiting + server-side input
-- sanitization. Zero-trust means these must hold even if a caller skips
-- our client entirely and hits the RPC/REST layer directly.
--
-- Also fixes a live vulnerability found while auditing purchase_ticket for
-- this pass: an old 4-argument overload (pre-dating the p_promo_code
-- parameter) was still present alongside the current 5-argument version.
-- A direct RPC call omitting p_promo_code would resolve to that old
-- overload, which has NONE of the advisory-lock idempotency, overselling,
-- or capacity checks added in the strict-ticketing-idempotency migration --
-- a complete bypass of that hardening. Dropped separately via
-- `DROP FUNCTION public.purchase_ticket(uuid, text, jsonb, text);` before
-- this migration (see session notes); this file only adds the new
-- protections on top of the one remaining, correct overload.

-- ── Rate limiting infrastructure ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key          text NOT NULL,
  window_start bigint NOT NULL,
  count        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- Best-effort trustworthy client IP for anonymous-callable RPCs (e.g.
-- promo code validation, which has no auth.uid() to key on). InsForge's
-- gateway appends the real observed connecting IP to x-forwarded-for after
-- whatever a client sends, so a spoofed client-supplied prefix can't
-- displace it -- we take the last entry that isn't a private/internal
-- address, stripping trailing hops like the postgrest container's own
-- bridge IP.
CREATE OR REPLACE FUNCTION public.client_ip()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_xff  text;
  v_ip   text;
  v_ips  text[];
BEGIN
  v_xff := current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for';
  IF v_xff IS NULL THEN RETURN 'unknown'; END IF;

  v_ips := regexp_split_to_array(v_xff, '\s*,\s*');
  FOR i IN REVERSE array_length(v_ips, 1)..1 LOOP
    v_ip := v_ips[i];
    IF v_ip !~ '^(10\.|127\.|0\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)' THEN
      RETURN v_ip;
    END IF;
  END LOOP;

  RETURN v_ips[1];
EXCEPTION WHEN OTHERS THEN
  RETURN 'unknown';
END;
$function$;

-- Fixed-window counter. Raises 'rate_limited' if the caller has already
-- made p_max_attempts calls with this key inside the current
-- p_window_seconds bucket. Opportunistically prunes old windows (1-in-50
-- calls) so the table doesn't grow unbounded without needing a cron job.
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_window bigint := floor(extract(epoch FROM now()) / p_window_seconds)::bigint;
  v_count  integer;
BEGIN
  INSERT INTO public.rate_limits (key, window_start, count)
  VALUES (p_key, v_window, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;

  IF random() < 0.02 THEN
    DELETE FROM public.rate_limits WHERE window_start < v_window - 10;
  END IF;

  IF v_count > p_max_attempts THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0429';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_ip() TO anon, authenticated;

-- ── Auth pre-flight rate limit (login / signup / password reset) ───────
-- InsForge's own /api/auth/* endpoints run outside our schema, so they
-- can't be gated at the RPC layer directly. This RPC is called by
-- AuthScreen.tsx BEFORE each attempt as defense-in-depth for traffic that
-- goes through our own client -- it does NOT stop a scripted attacker who
-- skips our app and calls InsForge's auth endpoint directly, which is a
-- limitation of this architecture (documented in the PR description, not
-- hidden). Dual-keyed: per-identifier (stop credential spraying one
-- account) and per-IP (stop one source brute-forcing many accounts).
CREATE OR REPLACE FUNCTION public.check_auth_rate_limit(p_action text, p_identifier text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_action NOT IN ('login', 'signup', 'password_reset') THEN
    RAISE EXCEPTION 'Invalid action';
  END IF;

  PERFORM public.check_rate_limit('auth:' || p_action || ':id:' || lower(coalesce(p_identifier, '')), 5, 300);
  PERFORM public.check_rate_limit('auth:' || p_action || ':ip:' || public.client_ip(), 20, 300);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_auth_rate_limit(text, text) TO anon, authenticated;

-- ── Apply rate limiting to abuse-prone RPCs ─────────────────────────────
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
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
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Script-abuse guard: a legitimate checkout is one call per attempt; 8
  -- per minute comfortably covers retries across a flaky connection
  -- without leaving room for a scripted mass-purchase loop.
  PERFORM public.check_rate_limit('ticket_purchase:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  SELECT array_agg(id) INTO v_existing_ids
  FROM public.tickets
  WHERE event_id = p_event_id AND user_id = v_user_id AND status = 'active';

  IF v_existing_ids IS NOT NULL THEN
    RETURN v_existing_ids;
  END IF;

  SELECT price, ticket_types, ticket_goal INTO v_event
  FROM public.events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
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
       holder_name, holder_email, promo_code, discount_percentage)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''),
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

CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid)
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
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  -- A real scanner at a door working through a queue is nowhere near this
  -- volume; this only engages against a scripted loop trying to brute-force
  -- ticket IDs/signatures.
  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

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

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin()
     AND p_actor_id <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
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
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned', 'message', 'This ticket was already scanned.');
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

CREATE OR REPLACE FUNCTION public.validate_promo_code(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_promo public.promo_codes;
  v_key   text;
BEGIN
  -- Callable anonymously (no auth.uid() check in this function), so a
  -- scripted code-guessing loop can't be keyed on a user id -- fall back
  -- to auth.uid() when logged in (tighter, per-account) and the observed
  -- client IP otherwise.
  v_key := COALESCE(auth.uid()::text, public.client_ip());
  PERFORM public.check_rate_limit('promo_check:' || v_key, 15, 60);

  IF p_code IS NULL OR trim(p_code) = '' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'Enter a promo code.');
  END IF;

  SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_code));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'Invalid promo code.');
  END IF;

  IF NOT v_promo.is_active THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code is no longer active.');
  END IF;

  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code has expired.');
  END IF;

  IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code has reached its usage limit.');
  END IF;

  RETURN jsonb_build_object('valid', true, 'discount_percentage', v_promo.discount_percentage);
END;
$function$;

-- ── Server-side input sanitization (defense in depth beyond the client's
--    zod schemas -- a direct table write or RPC call must not be able to
--    bypass them) ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_injection_patterns(p_label text, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  IF p_text IS NULL THEN RETURN; END IF;
  -- Postgres's regex engine (ARE) does not treat \b as a word boundary the
  -- way PCRE/Perl/JS do -- \y is the ARE word-boundary escape. Using \b
  -- here originally silently degraded to a literal "b", so
  -- '<script\b' only matched a literal "<scriptb" and never matched real
  -- "<script>" payloads. Caught by a live REST-based test, not by the
  -- CLI's own db-query path (which mangles backslash escapes in transit
  -- and gave a false negative even before this bug, adding confusion).
  IF p_text ~* '<script\y|<iframe\y|javascript:|on\w+\s*=\s*["'']' THEN
    RAISE EXCEPTION '% contains disallowed content', p_label;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_events_input()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF length(NEW.title) < 1 OR length(NEW.title) > 200 THEN
    RAISE EXCEPTION 'Event title must be between 1 and 200 characters';
  END IF;
  IF NEW.description IS NOT NULL AND length(NEW.description) > 5000 THEN
    RAISE EXCEPTION 'Event description must be 5000 characters or fewer';
  END IF;
  IF length(NEW.location) < 1 OR length(NEW.location) > 200 THEN
    RAISE EXCEPTION 'Event location must be between 1 and 200 characters';
  END IF;
  IF NEW.image_url IS NOT NULL AND NEW.image_url <> '' AND NEW.image_url !~* '^https?://' THEN
    RAISE EXCEPTION 'image_url must be an http(s) URL';
  END IF;

  PERFORM public.reject_injection_patterns('title', NEW.title);
  PERFORM public.reject_injection_patterns('description', NEW.description);
  PERFORM public.reject_injection_patterns('location', NEW.location);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_events_input ON public.events;
CREATE TRIGGER trg_validate_events_input
  BEFORE INSERT OR UPDATE OF title, description, location, image_url ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.validate_events_input();

CREATE OR REPLACE FUNCTION public.validate_users_input()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.full_name IS NOT NULL AND length(NEW.full_name) > 100 THEN
    RAISE EXCEPTION 'Full name must be 100 characters or fewer';
  END IF;
  IF NEW.bio IS NOT NULL AND length(NEW.bio) > 500 THEN
    RAISE EXCEPTION 'Bio must be 500 characters or fewer';
  END IF;

  PERFORM public.reject_injection_patterns('full_name', NEW.full_name);
  PERFORM public.reject_injection_patterns('bio', NEW.bio);

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_users_input ON public.users;
CREATE TRIGGER trg_validate_users_input
  BEFORE INSERT OR UPDATE OF full_name, bio ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.validate_users_input();
