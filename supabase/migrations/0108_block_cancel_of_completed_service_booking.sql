-- Master security audit (MEDIUM #5): cancel_service_booking() never checked
-- v_booking.status before cancelling and refunding. It only gated on
-- payment_status (paid / refund_pending / refunded), so a service provider
-- (or an admin) could cancel and fully refund a booking whose status was
-- already 'completed' -- i.e. the service was already delivered, and per
-- migration 0099's RLS policy, the customer may have already left a review
-- for it. This is the same issue class as refund-after-check-in for
-- tickets (already blocked in refund_ticket: "A checked-in ticket cannot
-- be refunded"), just unguarded here for service bookings.
--
-- Fix: add the smallest possible guard, in the same place and style as
-- refund_ticket's existing checked-in guard -- raise before any refund
-- logic runs if the booking is already 'completed'. Every other check
-- (auth, provider/admin-only, refund reason required, payment_status
-- state machine, wallet-refund double-credit guard via
-- ON CONFLICT (reference_id) ... DO NOTHING, organizer wallet debit,
-- fee-absorption logging) is unchanged.

CREATE OR REPLACE FUNCTION public.cancel_service_booking(p_booking_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking            record;
  v_provider_user_id   uuid;
  v_wallet_bal         bigint;
  v_actual_debit       bigint;
  v_wallet_refund_tx_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A refund reason is required';
  END IF;

  SELECT b.id, b.customer_id, b.provider_id, b.status, b.payment_status, b.payment_ref,
         b.payment_method, b.subtotal_kobo, b.fee_kobo, b.total_kobo, sp.user_id AS provider_user_id
    INTO v_booking
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.id = p_booking_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  IF v_booking.provider_user_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the service provider or an admin can cancel this booking';
  END IF;

  IF v_booking.status = 'completed' THEN
    RAISE EXCEPTION 'A completed booking cannot be cancelled or refunded';
  END IF;

  IF v_booking.payment_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'booking_id', v_booking.id);
  END IF;

  IF v_booking.payment_status = 'refund_pending' THEN
    RETURN jsonb_build_object(
      'status', 'refund_pending', 'booking_id', v_booking.id, 'payment_ref', v_booking.payment_ref
    );
  END IF;

  IF v_booking.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only paid bookings can be refunded (current status: %)', v_booking.payment_status;
  END IF;

  v_provider_user_id := v_booking.provider_user_id;

  IF v_booking.total_kobo <= 0 THEN
    UPDATE public.service_bookings
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_booking.id;

    INSERT INTO public.notifications (user_id, type, title, body)
    VALUES (v_booking.customer_id, 'booking', 'Booking cancelled',
            'Your service booking has been cancelled. Reason: ' || p_reason);

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (auth.uid(), 'cancel_service_booking', v_booking.customer_id,
            jsonb_build_object('booking_id', v_booking.id, 'reason', p_reason, 'amount_kobo', 0),
            public.actor_role());

    RETURN jsonb_build_object('status', 'refunded', 'booking_id', v_booking.id, 'amount_kobo', 0);
  END IF;

  IF v_booking.payment_method = 'wallet' THEN
    INSERT INTO public.user_wallets (user_id) VALUES (v_booking.customer_id)
    ON CONFLICT (user_id) DO NOTHING;

    PERFORM 1 FROM public.user_wallets WHERE user_id = v_booking.customer_id FOR UPDATE;

    INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
    VALUES (
      v_booking.customer_id, 'refund', v_booking.total_kobo, 'Service booking refund', v_booking.id::text,
      jsonb_build_object('booking_id', v_booking.id, 'platform_fee_absorbed_kobo', v_booking.fee_kobo)
    )
    ON CONFLICT (reference_id) WHERE (type = 'refund' AND reference_id IS NOT NULL) DO NOTHING
    RETURNING id INTO v_wallet_refund_tx_id;

    IF v_wallet_refund_tx_id IS NULL THEN
      RETURN jsonb_build_object('status', 'already_refunded', 'booking_id', v_booking.id);
    END IF;

    UPDATE public.user_wallets
       SET balance_kobo = balance_kobo + v_booking.total_kobo, updated_at = now()
     WHERE user_id = v_booking.customer_id;

    UPDATE public.service_bookings
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_booking.id;

    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_provider_user_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_booking.subtotal_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_provider_user_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
      VALUES (
        v_provider_user_id, 'refund', v_actual_debit,
        'Refund (Wallet): service booking' ||
          CASE WHEN v_actual_debit < v_booking.subtotal_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_booking.subtotal_kobo || ' kobo owed)'
               ELSE '' END,
        jsonb_build_object('service_booking_id', v_booking.id)
      );
    END IF;

    IF v_actual_debit < v_booking.subtotal_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_service_booking_wallet_shortfall', v_provider_user_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'owed_kobo', v_booking.subtotal_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_booking.subtotal_kobo - v_actual_debit
        ),
        public.actor_role()
      );
    END IF;

    IF v_booking.fee_kobo > 0 THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_platform_fee_absorbed', v_booking.customer_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'refund_method', 'wallet',
          'platform_fee_absorbed_kobo', v_booking.fee_kobo, 'refund_kobo', v_booking.total_kobo
        ),
        public.actor_role()
      );
    END IF;

    INSERT INTO public.notifications (user_id, type, title, body)
    VALUES (v_booking.customer_id, 'booking', 'Booking refunded',
            'Your service booking has been refunded to your VENTS Wallet. Reason: ' || p_reason);

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (auth.uid(), 'cancel_service_booking_wallet', v_booking.customer_id,
            jsonb_build_object('booking_id', v_booking.id, 'reason', p_reason, 'amount_kobo', v_booking.total_kobo),
            public.actor_role());

    RETURN jsonb_build_object(
      'status', 'refunded', 'booking_id', v_booking.id,
      'amount_kobo', v_booking.total_kobo, 'refund_method', 'wallet'
    );
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'refund_pending', status = 'cancelled',
         refund_reason = p_reason, refund_initiated_by = auth.uid()
   WHERE id = v_booking.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'cancel_service_booking_initiated', v_booking.customer_id,
    jsonb_build_object('booking_id', v_booking.id, 'reason', p_reason, 'amount_kobo', v_booking.total_kobo),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'status', 'refund_pending',
    'booking_id', v_booking.id,
    'payment_ref', v_booking.payment_ref,
    'amount_kobo', v_booking.total_kobo,
    'user_id', v_booking.customer_id
  );
END;
$function$;
