-- Verbatim copies of the LIVE production definitions of the money functions
-- migration 0203 patches (pg_get_functiondef, read-only, 2026-10-30).
-- Each body's md5(prosrc) was checked against production and is pinned
-- in 0203, which refuses to patch a function that has drifted.
-- Loaded with check_function_bodies = off; the test schemas supply the
-- tables and stubs they reference.
SET check_function_bodies = off;

-- create_pending_purchase
CREATE OR REPLACE FUNCTION public.create_pending_purchase(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_promo_code text DEFAULT NULL::text, p_payer_identifier text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id      uuid := auth.uid();
  v_event        record;
  v_ticket_obj   jsonb;
  v_unit_price   numeric;
  v_discount_pct numeric := 0;
  v_promo        public.promo_codes;
  v_count        integer;
  v_amount_kobo  bigint;
  v_payment_ref  text;
  v_promo_norm   text;
  v_attendees_hash text;
  v_existing     record;
  v_payer_id     uuid;
  v_payer_norm   text;
  v_requester_name text;
BEGIN
  IF public.purchases_disabled() THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase_intent:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  v_payer_norm := NULLIF(lower(trim(p_payer_identifier)), '');
  IF v_payer_norm IS NOT NULL THEN
    SELECT id INTO v_payer_id FROM public.users
     WHERE (lower(email) = v_payer_norm OR lower(username) = v_payer_norm)
       AND deleted_at IS NULL
     LIMIT 1;

    IF v_payer_id IS NULL THEN
      RETURN jsonb_build_object('payer_not_found', true);
    END IF;
    IF v_payer_id = v_user_id THEN
      RAISE EXCEPTION 'You cannot request payment from yourself -- just pay directly';
    END IF;
  END IF;

  SELECT price, ticket_types, deleted_at, status, event_date, hidden_by_admin, title
  INTO v_event
  FROM public.events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_event.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event has been removed and is no longer accepting purchases';
  END IF;
  IF v_event.status <> 'live' THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;
  IF v_event.hidden_by_admin THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;
  IF v_event.event_date::date < current_date THEN
    RAISE EXCEPTION 'This event has already ended';
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
    v_unit_price := COALESCE(v_event.price, 0);
  END IF;

  IF v_unit_price IS NULL OR v_unit_price < 0 THEN
    RAISE EXCEPTION 'This ticket type has an invalid price and cannot be purchased';
  END IF;

  v_promo_norm := NULLIF(upper(trim(p_promo_code)), '');
  IF v_promo_norm IS NOT NULL THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_promo_norm;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid promo code';
    END IF;
    IF NOT v_promo.is_active THEN
      RAISE EXCEPTION 'This promo code is no longer active';
    END IF;
    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
      RAISE EXCEPTION 'This promo code has expired';
    END IF;
    IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
      RAISE EXCEPTION 'This promo code has reached its usage limit';
    END IF;

    v_discount_pct := v_promo.discount_percentage;
  END IF;

  v_amount_kobo := round(v_unit_price * v_count * (1.05 - v_discount_pct / 100) * 100)::bigint;
  v_attendees_hash := md5(p_attendees::text);

  SELECT * INTO v_existing FROM public.pending_purchases
   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = p_ticket_type
     AND attendees_hash = v_attendees_hash
     AND promo_code IS NOT DISTINCT FROM v_promo_norm
     AND payer_id IS NOT DISTINCT FROM v_payer_id
     AND status = 'pending'
     AND created_at > now() - interval '30 minutes'
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('payment_ref', v_existing.payment_ref, 'amount_kobo', v_existing.amount_kobo);
  END IF;

  v_payment_ref := 'VNT-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.pending_purchases
    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at)
  VALUES
    (p_event_id, v_user_id, p_ticket_type, p_attendees, v_attendees_hash, v_promo_norm, v_amount_kobo, v_payment_ref, 'pending', v_payer_id,
     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END);

  IF v_payer_id IS NOT NULL THEN
    SELECT COALESCE(full_name, username, 'Someone') INTO v_requester_name
      FROM public.users WHERE id = v_user_id;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_payer_id,
      'event_update',
      'Payment requested 💳',
      v_requester_name || ' asked you to pay ' ||
        '₦' || to_char(round(v_amount_kobo / 100.0)::bigint, 'FM999,999,999') ||
        ' for a ' || p_ticket_type || ' ticket to ' || COALESCE(v_event.title, 'their event') || '.',
      false,
      '💳',
      jsonb_build_object('paymentRef', v_payment_ref)
    );
  END IF;

  RETURN jsonb_build_object('payment_ref', v_payment_ref, 'amount_kobo', v_amount_kobo);
END;
$function$;

-- confirm_ticket_payment
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
  v_prior_paid_count integer;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, t.payer_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_payer_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, t.payer_id, e.organizer_id, e.id;

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

  SELECT count(*) INTO v_prior_paid_count FROM public.tickets WHERE user_id = v_user_id AND payment_status = 'paid';

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
    PERFORM public.award_vc_reward(v_user_id, 'ticket_purchase', v_first_ticket_id);
    IF v_prior_paid_count = 0 THEN
      PERFORM public.award_vc_reward(v_user_id, 'first_ticket_purchase', v_first_ticket_id);
    END IF;
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
$function$;

-- confirm_ticket_payment_via_wallet
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment_via_wallet(p_payment_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid             uuid := auth.uid();
  v_user_id         uuid;
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
  v_wallet_balance  bigint;
  v_tx_id           uuid;
  v_prior_paid_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.purchases_disabled() THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Pending purchase not found for reference%' THEN
      RAISE WARNING 'confirm_ticket_payment_via_wallet: finalize_pending_purchase failed unexpectedly for %: %', p_payment_ref, SQLERRM;
      RAISE;
    END IF;
  END;

  PERFORM 1 FROM public.tickets WHERE payment_ref = p_payment_ref FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_payment_ref
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this payment reference';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_expected_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_expected_kobo::text;
  END IF;

  SELECT count(*) INTO v_prior_paid_count FROM public.tickets WHERE user_id = v_uid AND payment_status = 'paid';

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
  VALUES (v_uid, 'spend', v_expected_kobo, 'Ticket purchase: ' || v_ticket_type, p_payment_ref)
  ON CONFLICT (reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.user_wallets
     SET balance_kobo = balance_kobo - v_expected_kobo, updated_at = now()
   WHERE user_id = v_uid;

  UPDATE public.tickets
     SET payment_status = 'paid', payment_method = 'wallet'
   WHERE payment_ref = p_payment_ref AND payment_status <> 'paid';

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
      'wallet_reference', p_payment_ref,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale (Wallet): ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    PERFORM public.award_vc_reward(v_user_id, 'ticket_purchase', v_first_ticket_id);
    IF v_prior_paid_count = 0 THEN
      PERFORM public.award_vc_reward(v_user_id, 'first_ticket_purchase', v_first_ticket_id);
    END IF;
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
$function$;

-- refund_ticket
CREATE OR REPLACE FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket             record;
  v_refund_kobo        bigint;
  v_owed_kobo          bigint;
  v_platform_fee_kobo  bigint;
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

  PERFORM public.check_rate_limit('refund_ticket:' || auth.uid()::text, 30, 3600);

  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,
         t.ticket_type, t.user_id, t.checked_in, t.payment_method, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
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

  IF v_ticket.checked_in THEN
    RAISE EXCEPTION 'A checked-in ticket cannot be refunded';
  END IF;

  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  IF v_ticket.amount <= 0 OR v_refund_kobo <= 0 THEN
    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    PERFORM public.reverse_vc_reward(v_ticket.id, 'Ticket refunded: ' || p_reason);

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

  IF v_ticket.payment_method = 'wallet' THEN
    INSERT INTO public.user_wallets (user_id) VALUES (v_ticket.user_id)
    ON CONFLICT (user_id) DO NOTHING;

    PERFORM 1 FROM public.user_wallets WHERE user_id = v_ticket.user_id FOR UPDATE;

    v_platform_fee_kobo := GREATEST(0, v_refund_kobo - floor(v_ticket.amount * 100)::bigint);

    INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
    VALUES (
      v_ticket.user_id, 'refund', v_refund_kobo, 'Ticket refund: ' || v_ticket.ticket_type, v_ticket.id::text,
      jsonb_build_object('ticket_id', v_ticket.id, 'platform_fee_absorbed_kobo', v_platform_fee_kobo)
    )
    ON CONFLICT (reference_id) WHERE (type = 'refund' AND reference_id IS NOT NULL) DO NOTHING
    RETURNING id INTO v_wallet_refund_tx_id;

    IF v_wallet_refund_tx_id IS NULL THEN
      RETURN jsonb_build_object('status', 'already_refunded', 'ticket_id', v_ticket.id);
    END IF;

    UPDATE public.user_wallets
       SET balance_kobo = balance_kobo + v_refund_kobo, updated_at = now()
     WHERE user_id = v_ticket.user_id;

    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    PERFORM public.reverse_vc_reward(v_ticket.id, 'Ticket refunded: ' || p_reason);

    IF v_ticket.organizer_id IS NOT NULL THEN
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
          'Refund (Wallet): ' || v_ticket.ticket_type ||
            CASE WHEN v_actual_debit < v_owed_kobo
                 THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
                 ELSE '' END,
          v_ticket.id
        );
      END IF;

      IF v_actual_debit < v_owed_kobo THEN
        INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
        VALUES (
          auth.uid(), 'refund_wallet_shortfall', v_ticket.organizer_id,
          jsonb_build_object(
            'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
            'shortfall_kobo', v_owed_kobo - v_actual_debit
          ),
          public.actor_role()
        );
      END IF;
    END IF;

    IF v_platform_fee_kobo > 0 THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), 'refund_platform_fee_absorbed', v_ticket.user_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'refund_method', 'wallet',
          'platform_fee_absorbed_kobo', v_platform_fee_kobo, 'refund_kobo', v_refund_kobo
        ),
        public.actor_role()
      );
    END IF;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_ticket.user_id, 'booking', 'Ticket refunded',
      'Your ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been refunded to your VENTS Wallet. Reason: ' || p_reason,
      false, '💸',
      jsonb_build_object('ticketId', v_ticket.id)
    );

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (
      auth.uid(), 'refund_ticket_wallet', v_ticket.user_id,
      jsonb_build_object('ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', v_refund_kobo),
      public.actor_role()
    );

    RETURN jsonb_build_object('status', 'refunded', 'ticket_id', v_ticket.id, 'amount_kobo', v_refund_kobo, 'refund_method', 'wallet');
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
$function$;

-- finalize_ticket_refund
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

  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  UPDATE public.tickets SET payment_status = 'refunded' WHERE id = v_ticket.id;

  PERFORM public.reverse_vc_reward(v_ticket.id, 'Ticket refunded: ' || COALESCE(v_ticket.refund_reason, 'refund processed'));

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

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_ticket.user_id, 'booking', 'Ticket refunded',
    'Your refund for the ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been processed.',
    false, '💸'
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
$function$;

-- cancel_service_booking
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

-- finalize_service_booking_refund
CREATE OR REPLACE FUNCTION public.finalize_service_booking_refund(p_refund_id text)
 RETURNS TABLE(status text, customer_email text, customer_name text, refunded_amount_kobo bigint, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking      record;
  v_wallet_bal   bigint;
  v_actual_debit bigint;
BEGIN
  SELECT b.id, b.customer_id, b.provider_id, b.payment_status, b.refund_initiated_by, b.refund_reason,
         b.subtotal_kobo, b.fee_kobo, b.total_kobo, sp.user_id AS provider_user_id
    INTO v_booking
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.refund_id = p_refund_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_booking.payment_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_booking.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  UPDATE public.service_bookings SET payment_status = 'refunded' WHERE id = v_booking.id;

  IF v_booking.subtotal_kobo > 0 THEN
    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_booking.provider_user_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_booking.subtotal_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_booking.provider_user_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
      VALUES (
        v_booking.provider_user_id, 'refund', v_actual_debit,
        'Refund (Paystack): service booking' ||
          CASE WHEN v_actual_debit < v_booking.subtotal_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_booking.subtotal_kobo || ' kobo owed)'
               ELSE '' END,
        jsonb_build_object('service_booking_id', v_booking.id)
      );
    END IF;

    IF v_actual_debit < v_booking.subtotal_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_booking.refund_initiated_by, 'refund_service_booking_shortfall', v_booking.provider_user_id,
        jsonb_build_object(
          'booking_id', v_booking.id, 'owed_kobo', v_booking.subtotal_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_booking.subtotal_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking refunded', 'Your service booking has been refunded.');

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_booking.total_kobo, v_booking.refund_reason
    FROM public.users u WHERE u.id = v_booking.customer_id;
END;
$function$;


-- get_event_analytics
CREATE OR REPLACE FUNCTION public.get_event_analytics(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event record;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT id, title, organizer_id, ticket_goal, ticket_types
    INTO v_event
    FROM public.events
   WHERE id = p_event_id;

  IF v_event.id IS NULL THEN RAISE EXCEPTION 'Event not found'; END IF;
  IF v_event.organizer_id IS DISTINCT FROM v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized to view analytics for this event';
  END IF;

  WITH paid AS (
    -- The one "revenue-accurate" ticket set every metric below that touches
    -- money is filtered from -- active AND paid, nothing else.
    SELECT t.* FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active' AND t.payment_status = 'paid'
  ),
  active_any_payment AS (
    -- The broader "reserves capacity" set -- active regardless of payment_status,
    -- used only for remaining/availability math, never for revenue.
    SELECT t.* FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active'
  ),
  overview AS (
    SELECT
      count(*)::integer AS sold_count,
      COALESCE(sum(quantity), 0)::integer AS sold_quantity,
      COALESCE(sum(amount * 100), 0)::bigint AS gross_kobo,
      -- Per-ticket buyer fee via confirm_ticket_payment's own formula,
      -- summed -- informational only, never added to organizer earnings.
      COALESCE(sum(
        GREATEST(0, round(amount * (1.05 - COALESCE(discount_percentage, 0) / 100) * 100) - floor(amount * 100))
      ), 0)::bigint AS buyer_fee_kobo
    FROM paid
  ),
  counts AS (
    SELECT
      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND status = 'active' AND payment_status = 'pending')::integer AS pending_count,
      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND status = 'cancelled' AND payment_status <> 'refunded')::integer AS cancelled_count,
      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND payment_status = 'refunded')::integer AS refunded_count
  ),
  by_type_sold AS (
    SELECT ticket_type, count(*)::integer AS sold_count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY ticket_type
  ),
  by_type_reserved AS (
    SELECT ticket_type, count(*)::integer AS reserved_count
    FROM active_any_payment GROUP BY ticket_type
  ),
  type_defs AS (
    SELECT tt->>'name' AS name, NULLIF(tt->>'quantity', '')::integer AS type_quantity
    FROM jsonb_array_elements(COALESCE(v_event.ticket_types, '[]'::jsonb)) tt
  ),
  by_type AS (
    SELECT
      COALESCE(td.name, s.ticket_type, r.ticket_type) AS name,
      COALESCE(s.sold_count, 0) AS sold_count,
      COALESCE(s.revenue_kobo, 0) AS revenue_kobo,
      CASE WHEN td.type_quantity IS NOT NULL
        THEN GREATEST(0, td.type_quantity - COALESCE(r.reserved_count, 0))
        ELSE NULL
      END AS remaining
    FROM type_defs td
    FULL JOIN by_type_sold s ON s.ticket_type = td.name
    FULL JOIN by_type_reserved r ON r.ticket_type = COALESCE(td.name, s.ticket_type)
  ),
  sales_trend AS (
    SELECT date_trunc('day', created_at)::date AS day, count(*)::integer AS count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY 1 ORDER BY 1
  ),
  checkin_total AS (
    SELECT count(*)::integer AS checked_in_count
    FROM public.checkins WHERE event_id = p_event_id
  ),
  checkin_trend AS (
    SELECT date_trunc('day', checked_in_at)::date AS day, count(*)::integer AS count
    FROM public.checkins WHERE event_id = p_event_id GROUP BY 1 ORDER BY 1
  )
  SELECT jsonb_build_object(
    'eventTitle', v_event.title,
    'currency', 'NGN',
    'overview', jsonb_build_object(
      'soldCount', o.sold_count,
      'soldQuantity', o.sold_quantity,
      'ticketGoal', v_event.ticket_goal,
      'remaining', CASE WHEN v_event.ticket_goal > 0 THEN GREATEST(0, v_event.ticket_goal - o.sold_quantity) ELSE NULL END,
      'grossKobo', o.gross_kobo,
      'buyerFeeKobo', o.buyer_fee_kobo,
      'organizerEarnedKobo', o.gross_kobo,
      'pendingCount', c.pending_count,
      'cancelledCount', c.cancelled_count,
      'refundedCount', c.refunded_count
    ),
    'byTicketType', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', bt.name, 'soldCount', bt.sold_count, 'revenueKobo', bt.revenue_kobo, 'remaining', bt.remaining
      ) ORDER BY bt.revenue_kobo DESC) FROM by_type bt WHERE bt.name IS NOT NULL), '[]'::jsonb),
    'salesTrend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', to_char(st.day, 'YYYY-MM-DD'), 'count', st.count, 'revenueKobo', st.revenue_kobo
      ) ORDER BY st.day) FROM sales_trend st), '[]'::jsonb),
    'attendance', jsonb_build_object(
      'checkedInCount', ck.checked_in_count,
      'soldQuantity', o.sold_quantity,
      'attendancePct', CASE WHEN o.sold_quantity > 0 THEN round((ck.checked_in_count::numeric / o.sold_quantity) * 100, 1) ELSE NULL END
    ),
    'checkinTrend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', to_char(ct.day, 'YYYY-MM-DD'), 'count', ct.count
      ) ORDER BY ct.day) FROM checkin_trend ct), '[]'::jsonb)
  )
  INTO v_result
  FROM overview o, counts c, checkin_total ck;

  RETURN v_result;
END;
$function$
;

-- credit_organizer_wallet
CREATE OR REPLACE FUNCTION public.credit_organizer_wallet(p_organizer_id uuid, p_amount_kobo bigint, p_description text DEFAULT NULL::text, p_ticket_sale_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'credit_organizer_wallet: amount must be positive';
  END IF;

  IF p_organizer_id IS NULL THEN
    RAISE EXCEPTION 'credit_organizer_wallet: organizer_id is required';
  END IF;

  IF p_ticket_sale_id IS NULL THEN
    RAISE EXCEPTION 'credit_organizer_wallet: a verified ticket_sale_id is required';
  END IF;

  SELECT t.id, e.organizer_id, t.payment_status
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_sale_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % does not exist', p_ticket_sale_id;
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_organizer_id THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % does not belong to organizer %', p_ticket_sale_id, p_organizer_id;
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % is not paid (status=%)', p_ticket_sale_id, v_ticket.payment_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizer_transactions
    WHERE ticket_sale_id = p_ticket_sale_id AND type = 'credit'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo)
  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo      = organizer_wallets.balance_kobo + p_amount_kobo,
        total_earned_kobo = organizer_wallets.total_earned_kobo + p_amount_kobo,
        updated_at        = now();

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id, metadata)
  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id, p_metadata);
END;
$function$;


-- credit_provider_wallet_for_booking
CREATE OR REPLACE FUNCTION public.credit_provider_wallet_for_booking(p_provider_user_id uuid, p_amount_kobo bigint, p_booking_id uuid, p_description text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking record;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: amount must be positive';
  END IF;

  IF p_provider_user_id IS NULL THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: provider_user_id is required';
  END IF;

  IF p_booking_id IS NULL THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: a verified booking_id is required';
  END IF;

  -- Defense-in-depth (this function is never meant to be reachable except
  -- as a nested call from another SECURITY DEFINER payment-confirmation
  -- function, which already verified the payment) -- still verify the
  -- booking is real, paid, and actually belongs to the named provider, the
  -- same guard credit_organizer_wallet applies to ticket sales.
  SELECT b.id, sp.user_id AS provider_user_id, b.payment_status, b.subtotal_kobo
    INTO v_booking
    FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
   WHERE b.id = p_booking_id
   FOR UPDATE OF b;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: booking % does not exist', p_booking_id;
  END IF;

  IF v_booking.provider_user_id IS DISTINCT FROM p_provider_user_id THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: booking % does not belong to provider %', p_booking_id, p_provider_user_id;
  END IF;

  IF p_amount_kobo <> v_booking.subtotal_kobo THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: amount % does not match booking % subtotal %', p_amount_kobo, p_booking_id, v_booking.subtotal_kobo;
  END IF;

  IF v_booking.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'credit_provider_wallet_for_booking: booking % is not paid (status=%)', p_booking_id, v_booking.payment_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizer_transactions
    WHERE type = 'credit' AND metadata->>'service_booking_id' = p_booking_id::text
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo)
  VALUES (p_provider_user_id, p_amount_kobo, p_amount_kobo, 0, 0)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo = public.organizer_wallets.balance_kobo + p_amount_kobo,
        total_earned_kobo = public.organizer_wallets.total_earned_kobo + p_amount_kobo,
        updated_at = now();

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, metadata)
  VALUES (p_provider_user_id, 'credit', p_amount_kobo, p_description, jsonb_build_object('service_booking_id', p_booking_id));
END;
$function$;

-- confirm_service_booking_payment
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
     SET payment_status = 'paid', status = 'confirmed', payment_method = 'paystack', updated_at = now()
   WHERE id = v_booking.id;

  SELECT user_id INTO v_provider_user_id FROM public.service_providers WHERE id = v_booking.provider_id;

  PERFORM public.credit_provider_wallet_for_booking(v_provider_user_id, v_booking.subtotal_kobo, v_booking.id, 'Service booking payment');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking confirmed', 'Your service booking has been paid and confirmed.');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_provider_user_id, 'booking', 'New service booking', 'You have a new paid service booking. Check your bookings for details.');

  RETURN 'confirmed';
END;
$function$
;

-- confirm_service_booking_payment_via_wallet
CREATE OR REPLACE FUNCTION public.confirm_service_booking_payment_via_wallet(p_reference text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_booking public.service_bookings;
  v_provider_user_id uuid;
  v_wallet_balance bigint;
  v_tx_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_booking FROM public.service_bookings WHERE payment_ref = p_reference FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_booking.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not authorized for this booking';
  END IF;

  IF v_booking.payment_status = 'paid' THEN
    RETURN 'already_paid';
  END IF;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_kobo INTO v_wallet_balance
    FROM public.user_wallets WHERE user_id = v_uid FOR UPDATE;

  IF v_wallet_balance < v_booking.total_kobo THEN
    RETURN 'insufficient_balance:' || v_wallet_balance::text || ':' || v_booking.total_kobo::text;
  END IF;

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id)
  VALUES (v_uid, 'spend', v_booking.total_kobo, 'Service booking payment', p_reference)
  ON CONFLICT (reference_id) WHERE (type = 'spend' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_paid';
  END IF;

  UPDATE public.user_wallets
     SET balance_kobo = balance_kobo - v_booking.total_kobo, updated_at = now()
   WHERE user_id = v_uid;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', payment_method = 'wallet', updated_at = now()
   WHERE id = v_booking.id;

  SELECT user_id INTO v_provider_user_id FROM public.service_providers WHERE id = v_booking.provider_id;

  PERFORM public.credit_provider_wallet_for_booking(v_provider_user_id, v_booking.subtotal_kobo, v_booking.id, 'Service booking payment (Wallet)');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking confirmed', 'Your service booking has been paid (VENTS Wallet) and confirmed.');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_provider_user_id, 'booking', 'New service booking', 'You have a new paid service booking. Check your bookings for details.');

  RETURN 'confirmed';
END;
$function$
;
-- request_organizer_payout
CREATE OR REPLACE FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
  v_account      public.organizer_bank_accounts;
BEGIN
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a withdrawal';
  END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  IF p_idempotency_key IS NOT NULL AND trim(p_idempotency_key) <> '' THEN
    SELECT id INTO v_request_id
    FROM public.organizer_withdrawal_requests
    WHERE organizer_id = v_organizer_id AND idempotency_key = p_idempotency_key;
    IF v_request_id IS NOT NULL THEN
      RETURN v_request_id;
    END IF;
  END IF;

  SELECT * INTO v_account FROM public.organizer_bank_accounts
  WHERE id = p_bank_account_id AND organizer_id = v_organizer_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo - p_amount_kobo,
      pending_kobo = pending_kobo + p_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  BEGIN
    INSERT INTO public.organizer_withdrawal_requests
      (organizer_id, amount_kobo, bank_account_id, status, bank_name, bank_code, account_number, account_name, idempotency_key)
    VALUES
      (v_organizer_id, p_amount_kobo, p_bank_account_id, 'pending',
       v_account.bank_name, v_account.bank_code, v_account.account_number, v_account.account_name,
       NULLIF(trim(COALESCE(p_idempotency_key, '')), ''))
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.organizer_wallets
    SET balance_kobo = balance_kobo + p_amount_kobo,
        pending_kobo = GREATEST(0, pending_kobo - p_amount_kobo),
        updated_at = now()
    WHERE organizer_id = v_organizer_id;

    SELECT id INTO v_request_id
    FROM public.organizer_withdrawal_requests
    WHERE organizer_id = v_organizer_id AND idempotency_key = p_idempotency_key;
    RETURN v_request_id;
  END;

  RETURN v_request_id;
END;
$function$;

-- finalize_pending_purchase (not patched by 0203; md5 780f8c0e2082dcb1f46184cdfb9676f9 = production)
CREATE OR REPLACE FUNCTION public.finalize_pending_purchase(p_payment_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row           public.pending_purchases%ROWTYPE;
  v_event         record;
  v_ticket_obj    jsonb;
  v_unit_price    numeric;
  v_discount_pct  numeric := 0;
  v_effective     numeric;
  v_status        text;
  v_attendee      jsonb;
  v_ticket_id     uuid;
  v_ticket_ids    uuid[] := ARRAY[]::uuid[];
  v_count         integer;
  v_promo         public.promo_codes;
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
  v_result        jsonb := '[]'::jsonb;
  v_id            uuid;
BEGIN
  SELECT * INTO v_row FROM public.pending_purchases WHERE payment_ref = p_payment_ref FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending purchase not found for reference %', p_payment_ref;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_row.user_id AND auth.uid() IS DISTINCT FROM v_row.payer_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_row.status = 'completed' THEN
    SELECT array_agg(id) INTO v_ticket_ids FROM public.tickets
     WHERE payment_ref = p_payment_ref AND status = 'active';
  ELSE
    IF v_row.status IN ('cancelled', 'expired') THEN
      RAISE EXCEPTION 'This payment request is no longer active (%)', v_row.status;
    END IF;
    IF v_row.expires_at IS NOT NULL AND v_row.expires_at < now() THEN
      UPDATE public.pending_purchases SET status = 'expired' WHERE id = v_row.id;
      RAISE EXCEPTION 'This payment request has expired';
    END IF;

    -- REMOVED (fix 2): a disable_purchases check used to live here. By the
    -- time this branch runs for a real (non-free) purchase, the customer's
    -- money has already moved on Paystack's side (this function is called
    -- from finalizeAndConfirmPurchase, itself only invoked from the
    -- webhook / ?action=verify path, both of which run strictly after
    -- Paystack confirms charge.success). Blocking here does not prevent a
    -- new purchase -- it corrupts an already-paid one. The kill switch's
    -- job is done entirely by create_pending_purchase, which runs before
    -- any payment reference is ever shown to Paystack.

    PERFORM pg_advisory_xact_lock(hashtextextended(v_row.event_id::text, 0));

    SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, end_date, hidden_by_admin
    INTO v_event
    FROM public.events
    WHERE id = v_row.event_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Event not found';
    END IF;
    IF v_event.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'This event has been removed and is no longer accepting purchases';
    END IF;
    IF v_event.status <> 'live' THEN
      RAISE EXCEPTION 'This event is not currently open for ticket purchases';
    END IF;
    IF v_event.hidden_by_admin THEN
      RAISE EXCEPTION 'This event is not currently open for ticket purchases';
    END IF;
    IF now() >= public.event_effective_end_at(v_event.event_date, v_event.end_date) THEN
      RAISE EXCEPTION 'This event has already ended';
    END IF;

    IF v_event.ticket_types IS NOT NULL AND jsonb_array_length(v_event.ticket_types) > 0 THEN
      SELECT tt INTO v_ticket_obj
      FROM jsonb_array_elements(v_event.ticket_types) AS tt
      WHERE tt->>'name' = v_row.ticket_type
      LIMIT 1;

      IF v_ticket_obj IS NULL THEN
        RAISE EXCEPTION 'Ticket type not found';
      END IF;

      v_unit_price := (v_ticket_obj->>'price')::numeric;
    ELSE
      v_unit_price := COALESCE(v_event.price, 0);
    END IF;

    IF v_unit_price IS NULL OR v_unit_price < 0 THEN
      RAISE EXCEPTION 'This ticket type has an invalid price and cannot be purchased';
    END IF;

    v_count := jsonb_array_length(v_row.attendees);

    IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
      SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = v_row.event_id AND status = 'active';
      IF v_event_sold + v_count > v_event.ticket_goal THEN
        RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
      END IF;
    END IF;

    IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
      v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
      IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
        SELECT count(*) INTO v_type_sold
        FROM public.tickets
        WHERE event_id = v_row.event_id AND ticket_type = v_row.ticket_type AND status = 'active';

        IF v_type_sold + v_count > v_type_limit THEN
          RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), v_row.ticket_type;
        END IF;
      END IF;
    END IF;

    IF v_row.promo_code IS NOT NULL THEN
      SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
      IF FOUND THEN
        v_discount_pct := v_promo.discount_percentage;
      END IF;
    END IF;

    v_effective := v_unit_price * (1 - v_discount_pct / 100);
    v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

    FOR v_attendee IN SELECT * FROM jsonb_array_elements(v_row.attendees)
    LOOP
      IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
        RAISE EXCEPTION 'Each attendee must have a name';
      END IF;

      INSERT INTO public.tickets
        (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
         holder_name, holder_email, holder_phone, promo_code, discount_percentage, payer_id)
      VALUES
        (v_row.event_id, v_row.user_id, 1, v_row.ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
         trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''), NULLIF(trim(v_attendee->>'phone'), ''),
         CASE WHEN v_promo.id IS NOT NULL THEN v_row.promo_code ELSE NULL END, v_discount_pct, v_row.payer_id)
      RETURNING id INTO v_ticket_id;

      v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
    END LOOP;

    IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
      UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
    END IF;

    UPDATE public.pending_purchases SET status = 'completed' WHERE id = v_row.id;
  END IF;

  IF v_ticket_ids IS NOT NULL THEN
    FOREACH v_id IN ARRAY v_ticket_ids LOOP
      IF auth.uid() IS NOT NULL THEN
        v_result := v_result || jsonb_build_object('ticket_id', v_id, 'token', public.generate_ticket_token(v_id));
      ELSE
        v_result := v_result || jsonb_build_object('ticket_id', v_id, 'token', NULL);
      END IF;
    END LOOP;
  END IF;

  RETURN v_result;
END;
$function$;

-- complete_service_booking (not patched by 0203; md5 dd7b87dce8f49459baac1e6c2d06e98d = production).
-- 0203 stamps completed_at by trigger on its status update.
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

-- fail_service_booking_refund (not patched by 0203; md5 dce69756ccc75511c4932281c5e5ee19 = production).
CREATE OR REPLACE FUNCTION public.fail_service_booking_refund(p_refund_id text, p_reason text)
 RETURNS TABLE(status text, actor_email text, actor_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_booking record;
BEGIN
  SELECT id, customer_id, payment_status, refund_initiated_by
    INTO v_booking
    FROM public.service_bookings
   WHERE refund_id = p_refund_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_booking.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.service_bookings
     SET payment_status = 'paid', status = 'confirmed', refund_id = NULL
   WHERE id = v_booking.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_booking.refund_initiated_by, 'refund_service_booking_failed', v_booking.customer_id,
    jsonb_build_object('booking_id', v_booking.id, 'refund_id', p_refund_id, 'reason', p_reason),
    'webhook'
  );

  RETURN QUERY
  SELECT 'reverted'::text, u.email, u.full_name
    FROM public.users u WHERE u.id = v_booking.refund_initiated_by;
END;
$function$;

RESET check_function_bodies;
