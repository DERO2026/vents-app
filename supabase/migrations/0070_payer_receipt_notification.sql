-- Real bug found auditing the Someone Else Pays flow end-to-end: when a
-- payment request is successfully paid, confirm_ticket_payment notified
-- the ticket owner ("Ticket confirmed!") and the organizer ("New sale!"),
-- but never the payer -- Account B, who actually completed the Paystack
-- charge, got no in-app confirmation that their payment went through at
-- all. Fixed by looking up the ticket's payer_id (set by create_pending_
-- purchase only when this was a Someone Else Pays request; NULL for a
-- normal self-pay purchase, so this notification never fires for the
-- overwhelmingly common case) and, when a distinct payer exists, sending
-- them their own receipt-shaped notification -- naming the ticket holder
-- by name, never claiming the payer owns the ticket themselves. Same
-- notifications table, same type vocabulary, same push-delivery trigger
-- every other notification already rides; no new notification system.
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_payer_id        uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
  v_holder_name     text;
  v_holder_email    text;
  v_holder_phone    text;
  v_metadata        jsonb;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, max(t.payer_id), sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_payer_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'paystack'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),
      'paystack_reference', p_reference,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id, 'ticketId', v_first_ticket_id)
  );

  -- NEW: the payer's own receipt, only for a Someone Else Pays purchase
  -- (v_payer_id set, and genuinely a different person from the ticket
  -- owner -- defense in depth, since create_pending_purchase already
  -- rejects a payer_identifier resolving to yourself). Names the actual
  -- ticket holder so this never reads as if the payer owns the ticket.
  IF v_payer_id IS NOT NULL AND v_payer_id IS DISTINCT FROM v_user_id THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    SELECT
      v_payer_id,
      'booking',
      'Payment successful ✅',
      'Your payment for ' || COALESCE(u.full_name, u.username, 'their') || '''s ' || v_ticket_type ||
        ' ticket(s) to ' || v_event_title || ' was successful. Thanks for covering it!',
      false,
      '✅',
      jsonb_build_object('eventId', v_event_id)
    FROM public.users u WHERE u.id = v_user_id;
  END IF;

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_ticket_payment(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_ticket_payment(text, bigint) TO project_admin;
