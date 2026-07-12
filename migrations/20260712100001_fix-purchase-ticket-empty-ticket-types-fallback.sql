-- CRITICAL FIX — this is very likely the real cause behind "purchased
-- tickets don't show up in My Tickets": purchase_ticket's ticket-type
-- lookup (jsonb_array_elements(ticket_types) WHERE name = p_ticket_type)
-- returns zero rows for ANY event whose ticket_types column is empty/null,
-- causing a hard 'Ticket type not found' exception -- REGARDLESS of what
-- ticket type name the frontend sends. 18 of 23 events in this database
-- have an empty ticket_types array.
--
-- But mapDbEventToFrontend (HomeScreen.tsx) — the function that builds the
-- ticket types shown and selectable in EventDetailsScreen's "Select
-- Tickets" section for EVERY event, including these 18 — falls back to a
-- synthetic {name:'Regular', price: event.price} ticket type whenever
-- ticket_types is empty, and lets the user "buy" it normally. The RPC and
-- the UI have never agreed on what a ticket-type-less event's price is: the
-- UI happily sells one, the RPC always hard-rejects it.
--
-- Checkout's own error handling makes this invisible: handleCheckoutSuccess
-- catches the RPC exception, logs it to the console, and still navigates to
-- the payment-success screen regardless -- so the user sees "success" and
-- never learns their ticket was never actually created.
--
-- Fix: when an event has no configured ticket_types, fall back to the
-- event's own flat price server-side too, mirroring exactly what the
-- frontend already shows and sells.
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid := auth.uid();
  v_event      record;
  v_ticket_obj jsonb;
  v_unit_price numeric;
  v_status     text;
  v_attendee   jsonb;
  v_ticket_id  uuid;
  v_ticket_ids uuid[] := ARRAY[]::uuid[];
  v_count      integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  SELECT price, ticket_types INTO v_event
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
    -- No ticket types configured on this event at all — same fallback
    -- mapDbEventToFrontend uses to build the synthetic type the UI shows.
    v_unit_price := COALESCE(v_event.price, 0);
  END IF;

  v_status := CASE WHEN v_unit_price = 0 THEN 'paid' ELSE 'pending' END;

  FOR v_attendee IN SELECT * FROM jsonb_array_elements(p_attendees)
  LOOP
    IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each attendee must have a name';
    END IF;

    INSERT INTO public.tickets
      (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status, holder_name, holder_email)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''))
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
  END LOOP;

  RETURN v_ticket_ids;
END;
$function$;
