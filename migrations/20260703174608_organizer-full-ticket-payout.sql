-- Organizer receives the full ticket price (no 5% skim on payout).
-- The 5% Vents fee is already collected separately from the buyer at
-- checkout (see CheckoutScreen serviceFee); taking another 5% off the
-- organizer's payout here was double-charging the same fee.

CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_ticket_id      uuid;
  v_user_id        uuid;
  v_amount         numeric;
  v_payment_status text;
  v_ticket_type    text;
  v_organizer_id   uuid;
  v_event_title    text;
  v_expected_kobo  bigint;
  v_credit_kobo    bigint;
BEGIN
  SELECT t.id, t.user_id, t.amount, t.payment_status, t.ticket_type,
         e.organizer_id, e.title
    INTO v_ticket_id, v_user_id, v_amount, v_payment_status, v_ticket_type,
         v_organizer_id, v_event_title
  FROM public.tickets t
  JOIN public.events e ON e.id = t.event_id
  WHERE t.payment_ref = p_reference
  LIMIT 1;

  IF v_ticket_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  v_expected_kobo := round(v_amount * 100)::bigint;
  IF v_expected_kobo <> p_amount_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  IF v_payment_status = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.tickets SET payment_status = 'paid' WHERE id = v_ticket_id;

  IF v_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_amount * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type,
      v_ticket_id
    );
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_type || ' ticket for ' || v_event_title || ' is confirmed.',
    false,
    '🎟️'
  );

  RETURN 'confirmed';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.purchase_ticket(
  p_event_id       uuid,
  p_ticket_type    text,
  p_quantity       integer,
  p_payment_ref    text,
  p_payment_status text DEFAULT 'paid'
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id      uuid := auth.uid();
  v_ticket_obj   jsonb;
  v_unit_price   numeric;
  v_total        numeric;
  v_ticket_id    uuid;
  v_organizer_id uuid;
  v_credit_kobo  bigint;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_quantity < 1 OR p_quantity > 10 THEN
    RAISE EXCEPTION 'Quantity must be between 1 and 10';
  END IF;

  SELECT tt INTO v_ticket_obj
  FROM public.events,
       jsonb_array_elements(ticket_types) AS tt
  WHERE id = p_event_id
    AND tt->>'name' = p_ticket_type
  LIMIT 1;

  IF v_ticket_obj IS NULL THEN
    RAISE EXCEPTION 'Ticket type not found';
  END IF;

  -- Get organizer id for wallet credit
  SELECT organizer_id INTO v_organizer_id
  FROM public.events WHERE id = p_event_id;

  v_unit_price := (v_ticket_obj->>'price')::numeric;
  v_total      := v_unit_price * p_quantity;

  -- Insert ticket
  INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status)
  VALUES (p_event_id, v_user_id, p_quantity, p_ticket_type, v_total, p_payment_ref, p_payment_status, 'active')
  RETURNING id INTO v_ticket_id;

  -- Credit 50 VC to buyer
  IF v_total > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  -- Credit full ticket revenue (in kobo) to organizer wallet.
  -- The 5% Vents fee is already collected separately from the buyer.
  IF v_total > 0 AND v_organizer_id IS NOT NULL AND p_payment_status = 'paid' THEN
    v_credit_kobo := floor(v_total * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || p_ticket_type || ' x' || p_quantity,
      v_ticket_id
    );
  END IF;

  RETURN v_ticket_id;
END;
$$;
