-- Fix confirmed product-audit gap: service_bookings.status has a real
-- 'completed' value in its CHECK constraint (0054_service_bookings_
-- marketplace.sql), and ServiceBookingsScreen.tsx already renders a
-- distinct "Completed" badge style for it, but no function/RPC/UI anywhere
-- ever transitions a booking into that status -- it was unreachable in
-- production (confirmed live: zero service_bookings rows have ever had
-- status='completed').
--
-- Adds the provider-facing "mark this booking complete" action, mirroring
-- cancel_service_booking's existing shape (SECURITY DEFINER, lock the row,
-- authorize via service_providers.user_id = auth.uid() OR is_admin(),
-- idempotent, notifies the customer, logs to admin_logs).
--
-- Deliberately gated on payment_status = 'paid' -- an unpaid or refunded
-- booking should never be markable complete -- and on status = 'confirmed'
-- so a cancelled booking can't be resurrected into completed. This does
-- NOT touch cancel_service_booking, refund logic, wallet/payout accounting,
-- or RLS: completion has no money-moving side effect (the provider was
-- already credited at payment time, same as ticket sales), it only changes
-- the booking's own status column for both parties' records.

CREATE OR REPLACE FUNCTION public.complete_service_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT b.id, b.customer_id, b.status, b.payment_status, sp.user_id AS provider_user_id
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
    RAISE EXCEPTION 'Only the service provider or an admin can mark this booking complete';
  END IF;

  IF v_booking.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed', 'booking_id', v_booking.id);
  END IF;

  IF v_booking.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only a paid booking can be marked complete (current payment status: %)', v_booking.payment_status;
  END IF;

  IF v_booking.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed booking can be marked complete (current status: %)', v_booking.status;
  END IF;

  UPDATE public.service_bookings
     SET status = 'completed', updated_at = now()
   WHERE id = v_booking.id;

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking completed',
          'Your service booking has been marked complete by the provider. You can now leave a review.');

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'complete_service_booking', v_booking.customer_id,
          jsonb_build_object('booking_id', v_booking.id), public.actor_role());

  RETURN jsonb_build_object('status', 'completed', 'booking_id', v_booking.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_service_booking(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_service_booking(uuid) TO anon, authenticated, project_admin;
