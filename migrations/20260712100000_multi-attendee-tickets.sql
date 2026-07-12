-- Multi-attendee group checkout: one ticket ROW per attendee, not one row
-- with a quantity counter. Today a "buy 10 tickets" purchase inserts a
-- single row (quantity=10) with one shared ticket_id -- meaning one QR code
-- for the whole group, no way to record who each of the 10 tickets is for,
-- and no way for the door scanner to check each attendee in individually.
-- generate_ticket_token/verify_entry_pass/checkins already operate per
-- ticket row, so the fix is entirely in how rows get created: purchase_ticket
-- now takes an attendee array and inserts one row (quantity always 1) per
-- attendee, each carrying its own holder_name/holder_email.

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS holder_name text;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS holder_email text;

DROP FUNCTION IF EXISTS public.purchase_ticket(uuid, text, integer, text, text);

CREATE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid := auth.uid();
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
  -- p_payment_status is intentionally never accepted from the client — status
  -- is derived purely from the server-computed unit price, same as before.
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

-- confirm_ticket_payment now operates on every row sharing a payment_ref
-- (the whole group purchase), not a single ticket. Also fixes a real,
-- confirmed bug in the amount check: the webhook passes Paystack's actual
-- charged amount, which includes CheckoutScreen's 5% service fee, but the
-- old check compared it against the ticket's bare face-value amount (no
-- fee) -- meaning the check has NEVER matched for any real paid purchase,
-- so payment_status has never been flipped to 'paid' by this path and
-- organizers have never been credited via this webhook. Reconstructing the
-- same 5% fee here (matching CheckoutScreen.tsx's serviceFee formula) so
-- the comparison is against what was actually charged.
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_total_amount    numeric;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
BEGIN
  SELECT t.user_id, sum(t.amount), max(t.ticket_type), e.organizer_id, max(e.title),
         count(*), min(t.id), count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_ticket_type, v_organizer_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * 1.05 * 100)::bigint;
  IF v_expected_kobo <> p_amount_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id
    );
  END IF;

  IF v_total_amount > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️'
  );

  RETURN 'confirmed';
END;
$function$;
