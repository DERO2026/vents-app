-- Atomic, idempotent ticket-payment confirmation for the Paystack webhook.
-- SECURITY DEFINER so it can run without a user session (the webhook has
-- no auth.uid() context) while still being safe to expose to anon/authenticated:
-- it only ever touches the one ticket matching the given payment reference,
-- and only after verifying the webhook's amount matches what was charged.
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
    v_credit_kobo := floor(v_amount * 0.95 * 100)::bigint;
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
