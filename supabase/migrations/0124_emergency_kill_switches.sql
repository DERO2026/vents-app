-- Server-side emergency / kill-switch controls audit.
--
-- Traced every real backend entry point for money-moving operations
-- (ticket purchases, service bookings, organizer/provider payouts, wallet
-- deposits) against LIVE production function/grant definitions, not just
-- migration file contents.
--
-- FINDINGS AND FIXES:
--
-- 1. (CRITICAL, live regression) AdminSystemScreen.tsx's kill-switch
--    toggles (Ticket Purchases, QR Scanning, Sign-ups, Payouts, Location
--    Sharing, Maintenance Mode, Voice Notes, Image Sharing) call a raw
--    `supabase.from('app_config').update(...)` directly. `authenticated`
--    has zero UPDATE grant on app_config (confirmed live) -- every single
--    kill-switch toggle in the current production Admin Console currently
--    fails outright. admin_update_app_config (0083) already exists
--    specifically to be the one audited, Root-gated, whitelisted write path
--    for this table; the client was never wired to call it. Fixed in
--    AdminSystemScreen.tsx (this migration is DB-only; see the paired
--    client commit).
--
-- 2. (CRITICAL, live bug -- the "Important Paystack rule" in the brief)
--    finalize_pending_purchase re-checks disable_purchases on every call,
--    including the post-Paystack-charge reconciliation path
--    (finalizeAndConfirmPurchase, called from the webhook and ?action=
--    verify AFTER Paystack has already confirmed charge.success). If an
--    admin disables purchases while a card payment is in flight, this
--    would raise 'purchases_disabled' inside finalize_pending_purchase --
--    api/_lib/finalizePaystackPayment.ts swallows that specific exception
--    (logs and continues) so the customer isn't shown an error, but no
--    ticket row is ever created, and the subsequent confirm_ticket_payment
--    call then has nothing to mark paid: the customer is charged by
--    Paystack with no ticket and no automatic refund. The gate belongs
--    only on the pre-payment intent-creation step (create_pending_purchase
--    already has it, correctly), not on completing an already-charged
--    transaction. Removed here.
--
-- 3. (gap) request_organizer_payout (the actual withdrawal-request
--    creation RPC) had NO disable_payouts check at all -- only the
--    admin-side approve/reject/cancel actions did. A user could still
--    submit brand-new withdrawal requests while payouts were "disabled";
--    they just couldn't be approved. Added.
--
-- 4. (gap) service bookings and wallet deposits had no kill switch at all
--    -- no disable_bookings/disable_deposits column existed. Added both,
--    gated at their pre-payment entry points (create_service_booking,
--    initiate_wallet_deposit), never at their post-payment confirm steps
--    (confirm_service_booking_payment, confirm_wallet_deposit are already
--    project_admin-only -- unreachable by any client/old-app/direct-RPC
--    caller regardless).
--
-- 5. (fail-closed) every existing check used the bare pattern
--    `IF (SELECT disable_x FROM app_config LIMIT 1) THEN` -- if the
--    singleton row were ever missing, that subquery returns NULL, and
--    `IF NULL THEN` is never true in plpgsql: a missing/unreadable config
--    would FAIL OPEN (operation allowed) for every financially
--    consequential switch, the opposite of the required behavior. Replaced
--    every purchases/payouts/bookings/deposits check with one of four new
--    STABLE helper functions that COALESCE a missing/null value to `true`
--    (blocked) -- centralizing the fail-closed rule in one place rather
--    than repeating (and risking inconsistently repeating) it at every
--    call site.

-- ── New columns ──────────────────────────────────────────────────────────
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS disable_bookings boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disable_deposits boolean NOT NULL DEFAULT false;

-- ── Fail-closed helpers (one per financially consequential switch) ──────
CREATE OR REPLACE FUNCTION public.purchases_disabled()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT disable_purchases FROM public.app_config LIMIT 1), true);
$function$;

CREATE OR REPLACE FUNCTION public.payouts_disabled()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT disable_payouts FROM public.app_config LIMIT 1), true);
$function$;

CREATE OR REPLACE FUNCTION public.bookings_disabled()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT disable_bookings FROM public.app_config LIMIT 1), true);
$function$;

CREATE OR REPLACE FUNCTION public.deposits_disabled()
 RETURNS boolean
 LANGUAGE sql STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT disable_deposits FROM public.app_config LIMIT 1), true);
$function$;

REVOKE ALL ON FUNCTION public.purchases_disabled() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.payouts_disabled() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bookings_disabled() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.deposits_disabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchases_disabled() TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.payouts_disabled() TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.bookings_disabled() TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.deposits_disabled() TO authenticated, project_admin;

-- ── Fix 2: finalize_pending_purchase no longer gates the post-payment
--    reconciliation path. create_pending_purchase (the pre-payment intent
--    step) is the only correct place to block a NEW ticket purchase.
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

-- ── create_pending_purchase / purchase_ticket: switch to the fail-closed
--    helper (same check, same position -- first line, pre-payment).
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

CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id       uuid := auth.uid();
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
  v_existing_ids  uuid[];
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
BEGIN
  IF public.purchases_disabled() THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  SELECT array_agg(id) INTO v_existing_ids
  FROM public.tickets
  WHERE event_id = p_event_id AND user_id = v_user_id AND payment_ref = p_payment_ref AND status = 'active';

  IF v_existing_ids IS NOT NULL THEN
    RETURN v_existing_ids;
  END IF;

  SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, hidden_by_admin
  INTO v_event
  FROM public.events
  WHERE id = p_event_id
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

  IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
    SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = p_event_id AND status = 'active';
    IF v_event_sold + v_count > v_event.ticket_goal THEN
      RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
    END IF;
  END IF;

  IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
    v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
    IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
      SELECT count(*) INTO v_type_sold
      FROM public.tickets
      WHERE event_id = p_event_id AND ticket_type = p_ticket_type AND status = 'active';

      IF v_type_sold + v_count > v_type_limit THEN
        RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), p_ticket_type;
      END IF;
    END IF;
  END IF;

  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_promo_code));

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

  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

  FOR v_attendee IN SELECT * FROM jsonb_array_elements(p_attendees)
  LOOP
    IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each attendee must have a name';
    END IF;

    INSERT INTO public.tickets
      (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
       holder_name, holder_email, holder_phone, promo_code, discount_percentage)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''), NULLIF(trim(v_attendee->>'phone'), ''),
       CASE WHEN v_promo.id IS NOT NULL THEN upper(trim(p_promo_code)) ELSE NULL END, v_discount_pct)
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
  END LOOP;

  IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
  END IF;

  RETURN v_ticket_ids;
END;
$function$;

-- ── confirm_ticket_payment_via_wallet: the wallet-funded purchase path has
--    no separate async payment step (the wallet debit below IS the
--    payment), so this is the correct, pre-charge place to gate it now
--    that finalize_pending_purchase no longer carries the check.
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

-- ── Fix 4a: service bookings kill switch, gated at the pre-payment entry
--    point (create_service_booking writes the full row + payment_ref
--    before Paystack ever opens -- confirm_service_booking_payment is the
--    post-payment step and is already project_admin-only).
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
  IF public.bookings_disabled() THEN
    RAISE EXCEPTION 'bookings_disabled';
  END IF;

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

-- ── Fix 4b: wallet deposits kill switch, gated at the pre-payment entry
--    point (initiate_wallet_deposit mints the reference before Paystack
--    ever opens -- confirm_wallet_deposit is the post-payment step and is
--    already project_admin-only).
CREATE OR REPLACE FUNCTION public.initiate_wallet_deposit(p_amount_kobo bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ref text;
BEGIN
  IF public.deposits_disabled() THEN
    RAISE EXCEPTION 'deposits_disabled';
  END IF;

  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo < 50000 THEN
    RAISE EXCEPTION 'Minimum deposit is NGN 500';
  END IF;
  IF p_amount_kobo > 500000000 THEN
    RAISE EXCEPTION 'Maximum single deposit is NGN 5,000,000';
  END IF;

  PERFORM public.check_rate_limit('wallet_deposit_init:' || v_uid::text, 10, 3600);

  v_ref := 'wdep_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.wallet_deposit_attempts (reference, user_id, amount_kobo) VALUES (v_ref, v_uid, p_amount_kobo);

  RETURN jsonb_build_object('reference', v_ref, 'amountKobo', p_amount_kobo);
END;
$function$;

-- ── Fix 3: request_organizer_payout gets the check it never had. Same
--    signature as 0123 (bigint, uuid, text) -- CREATE OR REPLACE, no new
--    overload.
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

-- ── Admin-side payout actions: switch to the fail-closed helper. ────────
CREATE OR REPLACE FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text, claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND public.organizer_withdrawal_requests.status = 'pending'
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (auth.uid(), 'claim_payout_for_processing', jsonb_build_object('request_id', p_request_id), public.actor_role());
  END IF;

  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status, (v_claimed_id IS NOT NULL)
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT r.organizer_id, r.amount_kobo, r.status
    INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests r
  WHERE r.id = p_request_id;

  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_organizer_id, 'cancelled_payout_refund', v_amount_kobo,
          'Payout request cancelled by admin, funds returned — ' || p_reason, p_request_id);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_payout', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests WHERE id = p_request_id;
  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_payout_request', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$;

-- ── admin_update_app_config: add disable_bookings/disable_deposits to the
--    whitelist, and thread through an optional reason (existing audit
--    architecture already stores arbitrary jsonb detail; this adds the
--    field rather than inventing a new logging path). New 3-arg overload
--    replaces the 2-arg one so there is exactly one signature.
DROP FUNCTION IF EXISTS public.admin_update_app_config(text, text);

CREATE OR REPLACE FUNCTION public.admin_update_app_config(p_field text, p_value text, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old     jsonb;
  v_new     jsonb;
  v_oldval  text;
  v_newval  text;
  v_bool    boolean;
  v_int     integer;
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to change platform configuration (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;

  IF p_field IS NULL THEN RAISE EXCEPTION 'p_field is required'; END IF;

  SELECT to_jsonb(c) INTO v_old FROM public.app_config c WHERE c.id = true;
  IF v_old IS NULL THEN RAISE EXCEPTION 'app_config singleton row is missing'; END IF;
  v_oldval := v_old ->> p_field;

  CASE p_field

    WHEN 'maintenance_mode' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET maintenance_mode = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_purchases' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_purchases = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_scanning' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_scanning = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_signups' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_signups = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_payouts' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_payouts = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_location_sharing' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_location_sharing = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    -- NEW switches
    WHEN 'disable_bookings' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_bookings = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_deposits' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_deposits = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    WHEN 'voice_notes_enabled' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET voice_notes_enabled = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'image_sharing_enabled' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET image_sharing_enabled = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    WHEN 'broadcast_message' THEN
      UPDATE public.app_config SET broadcast_message = NULLIF(p_value, ''), updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'min_client_version' THEN
      IF p_value IS NULL OR p_value !~ '^[0-9]+\.[0-9]+\.[0-9]+$' THEN
        RAISE EXCEPTION 'min_client_version must look like 1.2.3';
      END IF;
      UPDATE public.app_config SET min_client_version = p_value, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    WHEN 'vc_naira_per_1000' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int <= 0 OR v_int > 1000000 THEN
        RAISE EXCEPTION 'vc_naira_per_1000 must be between 1 and 1000000';
      END IF;
      UPDATE public.app_config SET vc_naira_per_1000 = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'vc_min_ticket_price' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int < 0 THEN
        RAISE EXCEPTION 'vc_min_ticket_price must be >= 0';
      END IF;
      UPDATE public.app_config SET vc_min_ticket_price = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'vc_max_redemption_pct' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int < 0 OR v_int > 100 THEN
        RAISE EXCEPTION 'vc_max_redemption_pct must be between 0 and 100';
      END IF;
      UPDATE public.app_config SET vc_max_redemption_pct = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    ELSE
      RAISE EXCEPTION 'Unknown or non-updatable app_config field: %', p_field;
  END CASE;

  SELECT to_jsonb(c) INTO v_new FROM public.app_config c WHERE c.id = true;
  v_newval := v_new ->> p_field;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'app_config_update',
    NULL,
    jsonb_build_object('field', p_field, 'old_value', v_oldval, 'new_value', v_newval, 'reason', p_reason),
    public.actor_role()
  );

  RETURN jsonb_build_object('field', p_field, 'old_value', v_oldval, 'new_value', v_newval);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_app_config(text, text, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_update_app_config(text, text, text) TO authenticated;
