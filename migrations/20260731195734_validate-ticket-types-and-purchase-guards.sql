-- Fix 1 of 3 "High" launch-risk findings from the 2026-07-31 regression +
-- pattern audit.

-- ── Server-side validation of events.ticket_types ─────────────────────────
-- CreateEventScreen.tsx validated ticket-type price/quantity in the browser
-- only. events.price and tickets.quantity have CHECK constraints, but the
-- ticket_types jsonb array — the thing purchase_ticket actually reads
-- prices and inventory caps from — had none. An organizer writing directly
-- to their own row (permitted by update_events RLS) could store a negative
-- or missing price, or a bogus quantity, which purchase_ticket would then
-- consume raw into the wallet-credit path.
CREATE OR REPLACE FUNCTION public.validate_event_ticket_types()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_tt jsonb;
  v_price numeric;
  v_qty numeric;
BEGIN
  IF NEW.ticket_types IS NULL THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.ticket_types) <> 'array' THEN
    RAISE EXCEPTION 'ticket_types must be a JSON array';
  END IF;

  FOR v_tt IN SELECT * FROM jsonb_array_elements(NEW.ticket_types)
  LOOP
    IF NULLIF(trim(v_tt->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each ticket type must have a name';
    END IF;

    IF NOT (v_tt ? 'price') OR NULLIF(v_tt->>'price', '') IS NULL THEN
      RAISE EXCEPTION 'Ticket type "%" is missing a price', v_tt->>'name';
    END IF;

    BEGIN
      v_price := (v_tt->>'price')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Ticket type "%" has an invalid price', v_tt->>'name';
    END;

    IF v_price < 0 OR v_price > 100000000 THEN
      RAISE EXCEPTION 'Ticket type "%" price must be between 0 and 100,000,000', v_tt->>'name';
    END IF;

    IF v_tt ? 'quantity' AND NULLIF(v_tt->>'quantity', '') IS NOT NULL THEN
      BEGIN
        v_qty := (v_tt->>'quantity')::numeric;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Ticket type "%" has an invalid quantity', v_tt->>'name';
      END;

      IF v_qty <= 0 OR v_qty > 1000000 OR v_qty <> floor(v_qty) THEN
        RAISE EXCEPTION 'Ticket type "%" quantity must be a whole number between 1 and 1,000,000', v_tt->>'name';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_event_ticket_types_trigger ON public.events;
CREATE TRIGGER validate_event_ticket_types_trigger
  BEFORE INSERT OR UPDATE OF ticket_types ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_event_ticket_types();

-- ── purchase_ticket: re-check event eligibility inside the locked
--    transaction, and defend against a malformed ticket_types entry that
--    predates the trigger above ─────────────────────────────────────────
-- Original bug: purchase_ticket looked up the event by id and only checked
-- IF NOT FOUND — never deleted_at, status, or event_date. A buyer sitting
-- on the event page when the organizer soft-deletes (or after the event
-- has passed) could still complete a purchase seconds later: a ticket gets
-- issued for an event invisible everywhere else, and tickets.event_id has
-- ON DELETE RESTRICT, permanently blocking cleanup.
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
