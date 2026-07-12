-- Phase 4: Mission-Critical Ticketing hardening. Backend only.
--
-- Three real gaps, found by auditing the actual live functions (not
-- assumed):
--
-- 1. purchase_ticket had NO server-side duplicate-purchase protection at
--    all. The only guard was App.tsx's handleCheckoutSuccess doing a
--    SELECT-then-INSERT in JS -- a classic TOCTOU race: two rapid taps of
--    "Buy" (or a network retry) can both pass the client-side check before
--    either INSERT lands, creating two full ticket sets for the same
--    purchase. Fixed by making the RPC itself idempotent: an event-scoped
--    advisory lock serializes concurrent calls, and a user's existing
--    active tickets for the event are returned as-is instead of creating
--    duplicates.
--
-- 2. purchase_ticket had NO capacity check at all -- any number of tickets
--    could be sold past events.ticket_goal, and past a ticket type's own
--    declared quantity. The same advisory lock from (1) also serializes
--    this check against concurrent purchases for the same event (from
--    different users), closing the overselling race, not just the
--    single-user double-tap case.
--
-- 3. confirm_ticket_payment's amount/already-paid checks ran against a
--    plain (non-locked) aggregate SELECT. Two near-simultaneous Paystack
--    webhook deliveries for the same reference (Paystack's own docs
--    acknowledge duplicate delivery is possible) could both read
--    payment_status <> 'paid' before either commits its UPDATE, and both
--    proceed to credit the organizer's wallet and mint a VC-earn --  a
--    double-credit race. Fixed with a row-level FOR UPDATE lock on the
--    ticket rows before the aggregate read (Postgres doesn't allow FOR
--    UPDATE directly on a GROUP BY query, hence the two-step lock-then-
--    aggregate).
--
-- verify_entry_pass / generate_ticket_token were re-audited and are
-- already correct: HMAC-signed tokens, a FOR UPDATE row lock before the
-- atomic `UPDATE ... WHERE checked_in = false` compare-and-swap, and an
-- instant, same-transaction checkins insert. No changes needed there --
-- screenshot/QR-reuse fraud is already closed by that atomic swap (a
-- second scan of a copied QR always loses the race to whichever scan
-- landed first). No refund RPC exists in this codebase to audit -- flagged
-- separately, not built here (a net-new feature, not a hardening fix).

CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
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
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  -- Serializes every purchase attempt for this event (any user) so the
  -- capacity check below and the duplicate-purchase check are both
  -- race-free: pg_advisory_xact_lock blocks a concurrent call until this
  -- transaction commits or rolls back, then its own checks see accurate,
  -- committed state instead of a stale snapshot.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  -- Idempotent no-op: this user already has active tickets for this event
  -- (a prior call for this same checkout already succeeded, or a retry/
  -- double-tap landed here). Return the existing tickets rather than
  -- minting a second set.
  SELECT array_agg(id) INTO v_existing_ids
  FROM public.tickets
  WHERE event_id = p_event_id AND user_id = v_user_id AND status = 'active';

  IF v_existing_ids IS NOT NULL THEN
    RETURN v_existing_ids;
  END IF;

  SELECT price, ticket_types, ticket_goal INTO v_event
  FROM public.events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
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

  -- Anti-overselling: event-wide capacity. ticket_goal is 0 or NULL on 18
  -- of 23 events in this database today -- clearly never configured by the
  -- organizer, not a deliberate "zero capacity". Treating that as "no cap"
  -- avoids silently blocking every purchase for the majority of events;
  -- the check only actually engages once an organizer has set a real,
  -- positive capacity.
  IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
    SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = p_event_id AND status = 'active';
    IF v_event_sold + v_count > v_event.ticket_goal THEN
      RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
    END IF;
  END IF;

  -- Anti-overselling: this specific ticket type's own declared quantity,
  -- when one was configured as a real positive number (organizer-set
  -- inventory per type, e.g. VIP sold out while General is still
  -- available) -- same zero-means-unconfigured reasoning as above.
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
       holder_name, holder_email, promo_code, discount_percentage)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''),
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

CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
BEGIN
  -- Lock every ticket row in this payment group first. Postgres doesn't
  -- allow FOR UPDATE together with an aggregate/GROUP BY in one query, so
  -- this lock-then-aggregate is the two-step version of "SELECT ... FOR
  -- UPDATE" for an aggregate read. A second, near-simultaneous call for the
  -- same reference (e.g. a duplicate Paystack webhook delivery) blocks
  -- here until this transaction commits, then sees the now-'paid' rows and
  -- correctly short-circuits to already_paid below instead of crediting
  -- the organizer's wallet a second time.
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, max(e.title),
         count(*), min(t.id), count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_title,
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

  -- Matches CheckoutScreen.tsx: total = subtotal + subtotal*5% - subtotal*discount%
  --                                   = subtotal * (1.05 - discount%/100)
  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
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

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
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
