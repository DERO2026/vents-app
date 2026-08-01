-- ── Server-driven payment reconciliation ─────────────────────────────────
-- Root cause: purchase_ticket (which inserts the ticket row) only ever ran
-- client-side, AFTER Paystack's synchronous callback fired. confirm_ticket_payment
-- (the webhook handler) only ever UPDATEs a pre-existing ticket row keyed on
-- payment_ref — it has no ability to create one. So if the app is killed,
-- crashes, or loses network in the gap between Paystack charging the card and
-- the client's purchase_ticket_with_tokens call completing, the webhook fires,
-- finds no ticket row, logs "not_found", and stops. The buyer is charged with
-- zero server-side path to ever getting a ticket without contacting support.
-- Separately, every retry generated a brand-new Paystack reference client-side
-- with no dedup, so a user who thought their payment failed and retried could
-- be charged twice.
--
-- Fix: move purchase INTENT (event, ticket type, attendees, promo, and the
-- amount that will be charged) into a persisted row BEFORE the Paystack popup
-- ever opens, keyed by a server-issued payment_ref. The actual ticket-creation
-- logic (previously only in purchase_ticket) is now reachable via
-- finalize_pending_purchase, callable by EITHER the client (right after
-- Paystack's callback, for instant QR) OR the webhook (as the recovery path
-- if the client never got there) OR the client again later if it resumes
-- after the webhook already finalized it. All three converge on the same
-- idempotent row, locked FOR UPDATE, so concurrent/duplicate calls can never
-- create two ticket sets for one payment_ref.

CREATE TABLE IF NOT EXISTS public.pending_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  ticket_type text NOT NULL,
  attendees jsonb NOT NULL,
  attendees_hash text NOT NULL,
  promo_code text,
  amount_kobo bigint NOT NULL,
  payment_ref text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_purchases_dedup
  ON public.pending_purchases (user_id, event_id, ticket_type, attendees_hash, status, created_at DESC);

-- No direct table access for any client role — every read/write goes through
-- the SECURITY DEFINER RPCs below, same lockdown pattern already used for
-- public.tickets (migrations/20260726100000_lockdown-tickets-table-direct-writes.sql).
ALTER TABLE public.pending_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_purchases FROM PUBLIC, anon, authenticated;

-- ── 1. create_pending_purchase ────────────────────────────────────────────
-- Called by the client BEFORE opening the Paystack popup. Runs the same
-- event/ticket-type/promo validation purchase_ticket already does (a soft
-- pre-check — finalize_pending_purchase re-validates authoritatively once
-- payment is confirmed, since state can change in the gap). Computes the
-- amount server-side using the exact formula confirm_ticket_payment already
-- checks against (round(subtotal * (1.05 - discount/100) * 100)), so the
-- amount charged via Paystack and the amount confirm_ticket_payment expects
-- can never drift — the client now asks the server what to charge instead of
-- computing its own total and hoping it matches.
--
-- Retry dedup: if an identical pending purchase (same user/event/ticket
-- type/attendees/promo) was created in the last 30 minutes and is still
-- 'pending', its existing payment_ref/amount is returned instead of minting
-- a new one — a user who thinks their payment failed and taps Pay again
-- reuses the same Paystack reference rather than risking a second charge.
CREATE OR REPLACE FUNCTION public.create_pending_purchase(
  p_event_id uuid,
  p_ticket_type text,
  p_attendees jsonb,
  p_promo_code text DEFAULT NULL
)
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
BEGIN
  IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
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

  SELECT price, ticket_types, deleted_at, status, event_date, hidden_by_admin
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
     AND status = 'pending'
     AND created_at > now() - interval '30 minutes'
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('payment_ref', v_existing.payment_ref, 'amount_kobo', v_existing.amount_kobo);
  END IF;

  v_payment_ref := 'VNT-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.pending_purchases
    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status)
  VALUES
    (p_event_id, v_user_id, p_ticket_type, p_attendees, v_attendees_hash, v_promo_norm, v_amount_kobo, v_payment_ref, 'pending');

  RETURN jsonb_build_object('payment_ref', v_payment_ref, 'amount_kobo', v_amount_kobo);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_pending_purchase(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid, text, jsonb, text) TO authenticated;

-- ── 2. finalize_pending_purchase ──────────────────────────────────────────
-- The actual ticket-creation step, generalized from purchase_ticket to read
-- its inputs from a pending_purchases row (locked FOR UPDATE) instead of raw
-- parameters, so it can be driven by either the ticket owner OR the webhook.
-- Authorization: callable by the pending purchase's own owner (authenticated,
-- auth.uid() = row.user_id) or by an admin/service context with no user
-- session at all (auth.uid() IS NULL — the webhook, calling with
-- INSFORGE_API_KEY). Any OTHER authenticated user is rejected.
--
-- Idempotent: if the row is already 'completed', returns the existing
-- ticket ids instead of re-inserting — safe against duplicate webhook
-- delivery, a client retry, or the client resuming after the webhook already
-- finalized it while the app was closed. The FOR UPDATE lock on the pending
-- purchase row (not just the per-event advisory lock) makes a client call and
-- a webhook call racing each other for the SAME payment_ref serialize
-- correctly: the second to arrive sees status='completed' and returns the
-- first call's result.
--
-- Signed pass tokens can only be minted for the ticket's real owner
-- (generate_ticket_token enforces auth.uid() = ticket owner internally), so
-- they're only generated when this is called with an authenticated owner
-- session — never from the webhook's admin context. A ticket created by the
-- webhook recovery path gets its token lazily the normal way (ensureTicketToken)
-- whenever the owner next opens the app.
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

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_row.user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_row.status = 'completed' THEN
    SELECT array_agg(id) INTO v_ticket_ids FROM public.tickets
     WHERE payment_ref = p_payment_ref AND status = 'active';
  ELSE
    IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
      RAISE EXCEPTION 'purchases_disabled';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_row.event_id::text, 0));

    SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, hidden_by_admin
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
    IF v_event.event_date::date < current_date THEN
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
      -- A promo that goes invalid between create_pending_purchase and
      -- finalize (expired, exhausted) is intentionally NOT re-blocked here —
      -- the buyer already paid the discounted amount at the price quoted
      -- when payment was taken; rejecting now would strand a paid buyer with
      -- no ticket over a promo bookkeeping detail. current_uses is still
      -- incremented below when found, same as before.
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
         holder_name, holder_email, promo_code, discount_percentage)
      VALUES
        (v_row.event_id, v_row.user_id, 1, v_row.ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
         trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''),
         CASE WHEN v_promo.id IS NOT NULL THEN v_row.promo_code ELSE NULL END, v_discount_pct)
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

REVOKE EXECUTE ON FUNCTION public.finalize_pending_purchase(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_pending_purchase(text) TO authenticated, project_admin;
