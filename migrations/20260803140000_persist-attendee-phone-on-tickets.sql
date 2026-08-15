-- CheckoutScreen already collects and sends a phone number per attendee
-- (p_attendees[].phone) and now requires it before purchase, but neither
-- purchase path ever persisted it — only holder_name/holder_email were
-- written to public.tickets, so organizers had no way to actually reach a
-- buyer even though the data was collected at checkout.

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS holder_phone text;

-- Free-ticket path (purchase_ticket) — identical to the live definition
-- except holder_phone is now inserted alongside holder_name/holder_email.
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL::text)
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
  IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
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

  -- Idempotency keyed on the actual payment reference being retried, not
  -- merely "this user has some active ticket for this event".
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

-- Paid path (finalize_pending_purchase, called from the Paystack webhook /
-- client reconciliation) — identical to the live definition except
-- holder_phone is now inserted alongside holder_name/holder_email.
CREATE OR REPLACE FUNCTION public.finalize_pending_purchase(p_payment_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row           public.pending_purchases%ROWTYPE;
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
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
  v_result        jsonb := '[]'::jsonb;
  v_id            uuid;
BEGIN
  SELECT * INTO v_row FROM public.pending_purchases WHERE payment_ref = p_payment_ref FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending purchase not found for reference %', p_payment_ref;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_row.user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_row.status = 'completed' THEN
    SELECT array_agg(id) INTO v_ticket_ids FROM public.tickets
     WHERE payment_ref = p_payment_ref AND status = 'active';
  ELSE
    IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
      RAISE EXCEPTION 'purchases_disabled';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_row.event_id::text, 0));

    SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, hidden_by_admin
    INTO v_event
    FROM public.events
    WHERE id = v_row.event_id
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
      WHERE tt->>'name' = v_row.ticket_type
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

    v_count := jsonb_array_length(v_row.attendees);

    IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
      SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = v_row.event_id AND status = 'active';
      IF v_event_sold + v_count > v_event.ticket_goal THEN
        RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
      END IF;
    END IF;

    IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
      v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
      IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
        SELECT count(*) INTO v_type_sold
        FROM public.tickets
        WHERE event_id = v_row.event_id AND ticket_type = v_row.ticket_type AND status = 'active';

        IF v_type_sold + v_count > v_type_limit THEN
          RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), v_row.ticket_type;
        END IF;
      END IF;
    END IF;

    IF v_row.promo_code IS NOT NULL THEN
      SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
      -- A promo that goes invalid between create_pending_purchase and
      -- finalize (expired, exhausted) is intentionally NOT re-blocked here —
      -- the buyer already paid the discounted amount at the price quoted
      -- when payment was taken; rejecting now would strand a paid buyer with
      -- no ticket over a promo bookkeeping detail. current_uses is still
      -- incremented below when found, same as before.
      IF FOUND THEN
        v_discount_pct := v_promo.discount_percentage;
      END IF;
    END IF;

    v_effective := v_unit_price * (1 - v_discount_pct / 100);
    v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

    FOR v_attendee IN SELECT * FROM jsonb_array_elements(v_row.attendees)
    LOOP
      IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
        RAISE EXCEPTION 'Each attendee must have a name';
      END IF;

      INSERT INTO public.tickets
        (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
         holder_name, holder_email, holder_phone, promo_code, discount_percentage)
      VALUES
        (v_row.event_id, v_row.user_id, 1, v_row.ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
         trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''), NULLIF(trim(v_attendee->>'phone'), ''),
         CASE WHEN v_promo.id IS NOT NULL THEN v_row.promo_code ELSE NULL END, v_discount_pct)
      RETURNING id INTO v_ticket_id;

      v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
    END LOOP;

    IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
      UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
    END IF;

    UPDATE public.pending_purchases SET status = 'completed' WHERE id = v_row.id;
  END IF;

  IF v_ticket_ids IS NOT NULL THEN
    FOREACH v_id IN ARRAY v_ticket_ids LOOP
      IF auth.uid() IS NOT NULL THEN
        v_result := v_result || jsonb_build_object('ticket_id', v_id, 'token', public.generate_ticket_token(v_id));
      ELSE
        v_result := v_result || jsonb_build_object('ticket_id', v_id, 'token', NULL);
      END IF;
    END LOOP;
  END IF;

  RETURN v_result;
END;
$function$;
