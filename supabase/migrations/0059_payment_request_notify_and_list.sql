-- Fixes two real bugs found in manual Preview testing of the "Someone Else
-- Pays" flow shipped in 0058:
--
-- 1. create_pending_purchase resolved a payer but never told them a request
--    existed -- no notification of any kind was ever inserted, so Account B
--    never saw anything (in-app or push). Root cause: the notification
--    insert was simply never written. Fixed by inserting into
--    public.notifications exactly the way every other request-someone-to-
--    act flow in this codebase already does (see
--    initiate_transfer_fee_payment, 0043_ticket_transfer_fee.sql, and
--    confirm_service_booking_payment, 0054_service_bookings_marketplace.sql)
--    -- same table, same type vocabulary, same trigger
--    (trg_notify_push_on_notification_insert, 0047_push_delivery_db_webhook.sql)
--    that turns any notifications row into a push automatically. No parallel
--    notification system invented.
--
-- 2. PaymentRequestsScreen.tsx queried tickets.payer_id -- but no ticket
--    exists until AFTER payment, so a still-pending (or cancelled/expired)
--    request could never appear there, and it happened to work for
--    completed ones almost by accident. Root cause: there was no RPC for a
--    payer to list their own requests at all, so the client reached for the
--    wrong table. Fixed with a new get_my_payment_requests() RPC scoped to
--    pending_purchases.payer_id = auth.uid() -- covers pending, completed,
--    cancelled, and expired in one list (the same row persists through its
--    whole lifecycle; only its status changes), returning only the same
--    safe fields get_payment_request_details already exposes. No direct
--    client access to pending_purchases is granted -- it stays fully
--    project_admin-only at the table level, exactly as before.

-- ── 1. Notify the payer the moment a request naming them is created ──────
CREATE OR REPLACE FUNCTION public.create_pending_purchase(
  p_event_id uuid,
  p_ticket_type text,
  p_attendees jsonb,
  p_promo_code text DEFAULT NULL::text,
  p_payer_identifier text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id      uuid := auth.uid();
  v_event        record;
  v_ticket_obj   jsonb;
  v_unit_price   numeric;
  v_discount_pct numeric := 0;
  v_promo        public.promo_codes;
  v_count        integer;
  v_amount_kobo  bigint;
  v_payment_ref  text;
  v_promo_norm   text;
  v_attendees_hash text;
  v_existing     record;
  v_payer_id     uuid;
  v_payer_norm   text;
  v_requester_name text;
BEGIN
  IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase_intent:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  v_payer_norm := NULLIF(lower(trim(p_payer_identifier)), '');
  IF v_payer_norm IS NOT NULL THEN
    SELECT id INTO v_payer_id FROM public.users
     WHERE (lower(email) = v_payer_norm OR lower(username) = v_payer_norm)
       AND deleted_at IS NULL
     LIMIT 1;

    IF v_payer_id IS NULL THEN
      RETURN jsonb_build_object('payer_not_found', true);
    END IF;
    IF v_payer_id = v_user_id THEN
      RAISE EXCEPTION 'You cannot request payment from yourself -- just pay directly';
    END IF;
  END IF;

  SELECT price, ticket_types, deleted_at, status, event_date, hidden_by_admin
  INTO v_event
  FROM public.events
  WHERE id = p_event_id;

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

  v_promo_norm := NULLIF(upper(trim(p_promo_code)), '');
  IF v_promo_norm IS NOT NULL THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_promo_norm;

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

  v_amount_kobo := round(v_unit_price * v_count * (1.05 - v_discount_pct / 100) * 100)::bigint;
  v_attendees_hash := md5(p_attendees::text);

  SELECT * INTO v_existing FROM public.pending_purchases
   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = p_ticket_type
     AND attendees_hash = v_attendees_hash
     AND promo_code IS NOT DISTINCT FROM v_promo_norm
     AND payer_id IS NOT DISTINCT FROM v_payer_id
     AND status = 'pending'
     AND created_at > now() - interval '30 minutes'
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('payment_ref', v_existing.payment_ref, 'amount_kobo', v_existing.amount_kobo);
  END IF;

  v_payment_ref := 'VNT-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.pending_purchases
    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at)
  VALUES
    (p_event_id, v_user_id, p_ticket_type, p_attendees, v_attendees_hash, v_promo_norm, v_amount_kobo, v_payment_ref, 'pending', v_payer_id,
     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END);

  -- NEW: tell the resolved payer a request now exists. Same table, same
  -- type vocabulary ('event_update', already used by the analogous ticket-
  -- transfer-request notification), and the same push-delivery trigger every
  -- other notification in this app already rides -- nothing payment-request-
  -- specific was invented. push_data carries payment_ref so a future client
  -- can deep-link straight to it; today's client shows it via Profile ->
  -- Payment Requests, same as the body text says.
  IF v_payer_id IS NOT NULL THEN
    SELECT COALESCE(full_name, username, 'Someone') INTO v_requester_name FROM public.users WHERE id = v_user_id;

    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      v_payer_id, 'event_update', 'Payment request',
      v_requester_name || ' wants you to pay for their ' || p_ticket_type || ' ticket to ' || v_event.title || '. Open Payment Requests in your Profile to pay.',
      '💳', jsonb_build_object('paymentRef', v_payment_ref)
    );
  END IF;

  RETURN jsonb_build_object('payment_ref', v_payment_ref, 'amount_kobo', v_amount_kobo);
END;
$function$
;

-- ── 2. get_my_payment_requests: the payer's own list -- pending, completed,
-- cancelled, and expired, in one place. pending_purchases stays fully
-- project_admin-only at the table level (0031_restrict_finalize_pending_
-- purchase.sql); this is a narrow, SECURITY DEFINER read scoped to the
-- caller's own payer_id, returning the exact same safe field set
-- get_payment_request_details already exposes for a single reference --
-- never the raw table, never another user's rows, never attendee PII
-- (names/emails/phones) or the promo code.
CREATE OR REPLACE FUNCTION public.get_my_payment_requests()
 RETURNS TABLE(
   payment_ref text,
   event_title text,
   event_image_url text,
   ticket_type text,
   attendee_count integer,
   amount_kobo bigint,
   recipient_name text,
   status text,
   is_expired boolean,
   created_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    pp.payment_ref,
    e.title,
    e.image_url,
    pp.ticket_type,
    jsonb_array_length(pp.attendees),
    pp.amount_kobo,
    COALESCE(u.full_name, u.username),
    pp.status,
    (pp.status = 'pending' AND pp.expires_at IS NOT NULL AND pp.expires_at < now()),
    pp.created_at
  FROM public.pending_purchases pp
  JOIN public.events e ON e.id = pp.event_id
  JOIN public.users u ON u.id = pp.user_id
  WHERE pp.payer_id = (SELECT auth.uid())
  ORDER BY pp.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_my_payment_requests() FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_my_payment_requests() TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.create_pending_purchase(uuid, text, jsonb, text, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid, text, jsonb, text, text) TO authenticated, project_admin;
