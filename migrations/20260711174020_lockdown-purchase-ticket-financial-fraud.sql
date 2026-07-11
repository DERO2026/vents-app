-- CRITICAL SECURITY FIX — purchase_ticket financial-fraud lockdown.
--
-- purchase_ticket previously trusted a client-supplied p_payment_status
-- (default 'paid') and, when 'paid', immediately credited real kobo to the
-- organizer's withdrawable wallet. Any authenticated user could call the
-- RPC directly with a fabricated payment_ref and p_payment_status='paid',
-- skipping Paystack entirely and injecting fake, payout-eligible revenue.
--
-- Fix: payment status is now derived ENTIRELY server-side from the ticket's
-- own price (computed from the event's own ticket_types, not client input).
-- A genuinely free ticket (price 0) needs no payment step and is inserted
-- 'paid' immediately (nothing to credit either way). Anything with a real
-- price is always inserted 'pending' — it can only ever be flipped to
-- 'paid' (and only then does organizer-wallet AND buyer-VC crediting
-- happen) by confirm_ticket_payment, which is driven exclusively by the
-- HMAC-verified Paystack webhook (api/webhook/paystack.ts) and independently
-- re-checks the paid amount against the ticket's stored price before
-- accepting it. purchase_ticket can no longer credit anything, for anyone,
-- under any input.

CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_quantity integer, p_payment_ref text, p_payment_status text DEFAULT 'paid'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id      uuid := auth.uid();
  v_ticket_obj   jsonb;
  v_unit_price   numeric;
  v_total        numeric;
  v_ticket_id    uuid;
  v_status       text;
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

  v_unit_price := (v_ticket_obj->>'price')::numeric;
  v_total      := v_unit_price * p_quantity;

  -- p_payment_status is intentionally ignored — it is NEVER trusted. Status
  -- is derived purely from the server-computed price.
  v_status := CASE WHEN v_total = 0 THEN 'paid' ELSE 'pending' END;

  INSERT INTO public.tickets (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status)
  VALUES (p_event_id, v_user_id, p_quantity, p_ticket_type, v_total, p_payment_ref, v_status, 'active')
  RETURNING id INTO v_ticket_id;

  RETURN v_ticket_id;
END;
$function$;

-- confirm_ticket_payment gains the buyer VC-earn credit (moved here from
-- purchase_ticket, alongside the organizer wallet credit it already does) —
-- both now only ever fire once a real, amount-verified payment is confirmed.
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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

  IF v_amount > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_ticket_id, now())
    ON CONFLICT DO NOTHING;
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
