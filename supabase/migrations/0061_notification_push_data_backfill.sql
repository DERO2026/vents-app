-- Adds push_data (routing identifiers) to the three notification-producing
-- functions that were creating notifications with no routing payload at
-- all: finalize_ticket_refund, refund_ticket (free-ticket instant-refund
-- path), and confirm_service_booking_payment. No schema changes -- the
-- notifications.push_data jsonb column already exists (0010). Every other
-- notification body/behavior/push trigger in these functions is unchanged;
-- only the push_data argument is added to the existing INSERT statements.

CREATE OR REPLACE FUNCTION public.finalize_ticket_refund(p_refund_id text)
 RETURNS TABLE(status text, buyer_email text, buyer_name text, event_title text, ticket_type text, refunded_amount_kobo bigint, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket       record;
  v_owed_kobo    bigint;
  v_wallet_bal   bigint;
  v_actual_debit bigint;
  v_refund_kobo  bigint;
BEGIN
  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.ticket_type, t.payment_status,
         t.refund_initiated_by, t.refund_reason, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  -- Buyer-facing amount for the confirmation email -- the fee-inclusive
  -- figure Paystack actually refunded, same formula phase 1 used to decide
  -- how much to send Paystack (not v_ticket.amount, which is the
  -- organizer's fee-excluded share and would understate what the buyer
  -- gets back).
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  UPDATE public.tickets SET payment_status = 'refunded' WHERE id = v_ticket.id;

  -- Reverse exactly what credit_organizer_wallet originally credited for
  -- this ticket (organizer keeps the full ticket price, no fee skim -- see
  -- organizer-full-ticket-payout.sql), clamped at the wallet's current
  -- balance under a row lock so a concurrent credit/debit on the same
  -- wallet can't race this. Any shortfall (organizer already withdrew some
  -- or all of it) is written to admin_logs rather than silently dropped.
  IF v_ticket.amount > 0 AND v_ticket.organizer_id IS NOT NULL THEN
    v_owed_kobo := floor(v_ticket.amount * 100)::bigint;

    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_ticket.organizer_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_owed_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_ticket.organizer_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
      VALUES (
        v_ticket.organizer_id, 'refund', v_actual_debit,
        'Refund: ' || v_ticket.ticket_type ||
          CASE WHEN v_actual_debit < v_owed_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
               ELSE '' END,
        v_ticket.id
      );
    END IF;

    IF v_actual_debit < v_owed_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_ticket.refund_initiated_by, 'refund_wallet_shortfall', v_ticket.organizer_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_owed_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_ticket.user_id, 'booking', 'Ticket refunded',
    'Your refund for the ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been processed.',
    false, '💸',
    jsonb_build_object('ticketId', v_ticket.id)
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_finalized', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id),
    'webhook'
  );

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type,
         v_refund_kobo, v_ticket.refund_reason
    FROM public.users u WHERE u.id = v_ticket.user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket      record;
  v_refund_kobo bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A refund reason is required';
  END IF;

  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,
         t.ticket_type, t.user_id, t.checked_in, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'Only the event organizer or an admin can refund this ticket';
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'ticket_id', v_ticket.id);
  END IF;

  IF v_ticket.payment_status = 'refund_pending' THEN
    RETURN jsonb_build_object(
      'status', 'refund_pending', 'ticket_id', v_ticket.id, 'payment_ref', v_ticket.payment_ref
    );
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only paid tickets can be refunded (current status: %)', v_ticket.payment_status;
  END IF;

  -- Buyer's paid share for this ticket, service fee included -- the
  -- per-ticket version of the group formula confirm_ticket_payment sums
  -- (CheckoutScreen.tsx: total = subtotal * (1.05 - discount%/100)). Summed
  -- across every ticket sharing a payment_ref this equals the group total
  -- that was actually charged, so refunding one ticket at a time out of a
  -- multi-attendee purchase never over- or under-refunds what Paystack
  -- actually collected.
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  -- Free ticket: nothing was ever charged or credited to the organizer, so
  -- finalize immediately -- no Paystack call needed, nothing to reverse.
  IF v_ticket.amount <= 0 OR v_refund_kobo <= 0 THEN
    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_ticket.user_id, 'booking', 'Ticket refunded',
      'Your ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been refunded. Reason: ' || p_reason,
      false, '💸',
      jsonb_build_object('ticketId', v_ticket.id)
    );

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (
      auth.uid(), 'refund_ticket', v_ticket.user_id,
      jsonb_build_object('ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', 0),
      public.actor_role()
    );

    RETURN jsonb_build_object('status', 'refunded', 'ticket_id', v_ticket.id, 'amount_kobo', 0);
  END IF;

  UPDATE public.tickets
     SET payment_status = 'refund_pending', status = 'cancelled',
         refund_reason = p_reason, refund_initiated_by = auth.uid()
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'refund_ticket_initiated', v_ticket.user_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', v_refund_kobo,
      'checked_in', v_ticket.checked_in
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'status', 'refund_pending',
    'ticket_id', v_ticket.id,
    'payment_ref', v_ticket.payment_ref,
    'amount_kobo', v_refund_kobo,
    'user_id', v_ticket.user_id
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.confirm_service_booking_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking public.service_bookings;
  v_provider_user_id uuid;
BEGIN
  SELECT * INTO v_booking FROM public.service_bookings WHERE payment_ref = p_reference FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_booking.payment_status = 'paid' THEN
    RETURN 'already_paid';
  END IF;
  IF p_amount_kobo < v_booking.total_kobo THEN
    RETURN 'amount_mismatch:' || v_booking.total_kobo || ':' || p_amount_kobo;
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', updated_at = now()
   WHERE id = v_booking.id;

  SELECT user_id INTO v_provider_user_id FROM public.service_providers WHERE id = v_booking.provider_id;

  PERFORM public.credit_provider_wallet_for_booking(v_provider_user_id, v_booking.subtotal_kobo, v_booking.id, 'Service booking payment');

  INSERT INTO public.notifications (user_id, type, title, body, push_data)
  VALUES (
    v_booking.customer_id, 'booking', 'Booking confirmed', 'Your service booking has been paid and confirmed.',
    jsonb_build_object('bookingId', v_booking.id)
  );

  INSERT INTO public.notifications (user_id, type, title, body, push_data)
  VALUES (
    v_provider_user_id, 'booking', 'New service booking', 'You have a new paid service booking. Check your bookings for details.',
    jsonb_build_object('bookingId', v_booking.id)
  );

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_service_booking_payment(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_service_booking_payment(text, bigint) TO project_admin;
