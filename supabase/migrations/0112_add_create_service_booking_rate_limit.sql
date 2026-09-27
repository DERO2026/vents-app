-- Master security audit (booking-abuse cap, noted alongside M1/M4):
-- create_service_booking() had no check_rate_limit() call, unlike every
-- money-adjacent RPC hardened earlier in this audit. It never moves money
-- itself (server-computed pricing, no payment until a separate confirm
-- step) and a pending_payment booking auto-cleans up in practice, so this
-- was correctly noted as a DB-clutter/mild-abuse risk rather than a
-- user-harm one -- an attacker could spam pending_payment rows against a
-- specific provider, not steal funds. Fix: add the same PERFORM public.
-- check_rate_limit(...) pattern used throughout this audit, keyed
-- per-caller, before the provider/items validation. 20/hour is generous
-- for a real customer booking multiple services across a session while
-- still capping a scripted spam loop. No other logic changes.

CREATE OR REPLACE FUNCTION public.create_service_booking(p_provider_id uuid, p_items jsonb, p_scheduled_date date DEFAULT NULL::date, p_scheduled_time time without time zone DEFAULT NULL::time without time zone, p_location text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(booking_id uuid, payment_ref text, subtotal_kobo bigint, fee_kobo bigint, total_kobo bigint, currency text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_customer uuid := auth.uid();
  v_currency text;
  v_subtotal_kobo bigint := 0;
  v_fee_percent numeric;
  v_fee_kobo bigint;
  v_total_kobo bigint;
  v_booking_id uuid;
  v_ref text;
  v_item jsonb;
  v_service_id uuid;
  v_qty integer;
  v_name text;
  v_price numeric;
  v_svc_currency text;
  v_unit_kobo bigint;
BEGIN
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('create_service_booking:' || v_customer::text, 20, 3600);

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No services selected';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_providers sp
    JOIN public.users u ON u.id = sp.user_id
    WHERE sp.id = p_provider_id AND sp.status = 'approved' AND u.is_service_provider = true
  ) THEN
    RAISE EXCEPTION 'This provider is not available for booking';
  END IF;

  IF EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = p_provider_id AND sp.user_id = v_customer) THEN
    RAISE EXCEPTION 'You cannot book your own services';
  END IF;

  CREATE TEMP TABLE _service_booking_items (
    service_id uuid, service_name text, unit_price_kobo bigint, quantity integer, line_total_kobo bigint
  ) ON COMMIT DROP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::integer, 1);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity';
    END IF;

    v_service_id := (v_item->>'service_id')::uuid;

    SELECT ps.name, ps.price, ps.currency INTO v_name, v_price, v_svc_currency
    FROM public.provider_services ps
    WHERE ps.id = v_service_id AND ps.provider_id = p_provider_id AND ps.is_active = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'One of the selected services is unavailable';
    END IF;

    IF v_currency IS NULL THEN
      v_currency := v_svc_currency;
    ELSIF v_currency <> v_svc_currency THEN
      RAISE EXCEPTION 'All selected services in one booking must use the same currency';
    END IF;

    v_unit_kobo := round(v_price * 100);
    INSERT INTO _service_booking_items VALUES (v_service_id, v_name, v_unit_kobo, v_qty, v_unit_kobo * v_qty);
    v_subtotal_kobo := v_subtotal_kobo + (v_unit_kobo * v_qty);
  END LOOP;

  IF v_currency IS DISTINCT FROM 'NGN' THEN
    RAISE EXCEPTION 'Online booking is currently only available for services priced in NGN';
  END IF;

  v_fee_percent := public.get_service_booking_fee_percent();
  v_fee_kobo := round(v_subtotal_kobo * v_fee_percent / 100.0);
  v_total_kobo := v_subtotal_kobo + v_fee_kobo;
  v_ref := 'BKG-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.service_bookings (
    customer_id, provider_id, status, scheduled_date, scheduled_time, location, customer_notes,
    currency, subtotal_kobo, fee_kobo, total_kobo, payment_ref, payment_status
  ) VALUES (
    v_customer, p_provider_id, 'pending_payment', p_scheduled_date, p_scheduled_time, p_location, p_notes,
    v_currency, v_subtotal_kobo, v_fee_kobo, v_total_kobo, v_ref, 'pending'
  ) RETURNING id INTO v_booking_id;

  INSERT INTO public.service_booking_items (booking_id, service_id, service_name, unit_price_kobo, quantity, line_total_kobo)
  SELECT v_booking_id, i.service_id, i.service_name, i.unit_price_kobo, i.quantity, i.line_total_kobo
  FROM _service_booking_items i;

  RETURN QUERY SELECT v_booking_id, v_ref, v_subtotal_kobo, v_fee_kobo, v_total_kobo, v_currency;
END;
$function$;
