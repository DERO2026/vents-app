-- "Someone Else Pays" ticket flow -- additive only, nothing existing changes
-- shape or behavior. When payer_id is NULL (every purchase today, and every
-- purchase where the buyer pays for themselves going forward), behavior is
-- byte-for-byte identical to before this migration.
--
-- Design recap (see prior audit turn for the full trace):
--   - pending_purchases.user_id remains the RECIPIENT (ticket holder) --
--     never reassigned, never conflated with the payer.
--   - pending_purchases.payer_id (new, nullable) is the ONLY other identity
--     ever authorized to complete payment for that specific payment_ref.
--   - tickets.payer_id (new, nullable) mirrors it once the ticket is
--     created, purely so the payer has a real, queryable receipt row --
--     it grants no ownership, check-in, or transfer rights whatsoever.
--   - Payer must be an existing VENTS account (resolved by email or
--     username at request-creation time) -- no anonymous/guest payment
--     infrastructure.

-- ── 1. payer_id columns ──────────────────────────────────────────────────
-- expires_at is nullable and NEVER auto-populated for a normal self-pay
-- purchase -- only create_pending_purchase, and only when a payer_id is
-- actually resolved, ever sets it (to now() + 48h). A plain purchase keeps
-- expires_at NULL forever, exactly like before this migration existed.
ALTER TABLE public.pending_purchases
  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS idx_pending_purchases_payer_id ON public.pending_purchases (payer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_payer_id ON public.tickets (payer_id);

-- ── 2. Recognize cancelled/expired as real terminal states ───────────────
ALTER TABLE public.pending_purchases DROP CONSTRAINT IF EXISTS pending_purchases_status_check;
ALTER TABLE public.pending_purchases
  ADD CONSTRAINT pending_purchases_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text, 'expired'::text]));

-- ── 3. Payer-only ticket receipt read -- SELECT only, no write path of any
-- kind for a payer. Ticket ownership (user_id), check-in, and transfer are
-- completely untouched by this policy.
CREATE POLICY tickets_select_own_as_payer ON public.tickets
  FOR SELECT
  TO authenticated
  USING (payer_id = (SELECT auth.uid()));

-- ── 4. create_pending_purchase gains an optional payer identifier ───────
-- Resolves to an EXISTING VENTS account only (by email or username, case-
-- insensitive) -- never creates a user, never accepts a raw email/phone as
-- a standalone identity. Returns 'payer_not_found' as a distinguishable
-- jsonb field (not an exception) so the client can show "invite them to
-- create a VENTS account" instead of a generic failure, without ever
-- silently falling back to "I'm paying" behavior on a typo.
-- The old 4-arg signature must be dropped explicitly, not just replaced --
-- CREATE OR REPLACE with a different parameter LIST creates a new
-- overload alongside the old one (Postgres identifies a function by name
-- + parameter types), and PostgREST resolves an RPC call by matching
-- named JSON body params against whichever overload fits. Leaving the old
-- 4-arg version in place would let a client that only ever sends the
-- original 4 fields keep silently calling the OLD function forever (no
-- payer_id, no new dedup scoping) instead of erroring or upgrading.
DROP FUNCTION IF EXISTS public.create_pending_purchase(uuid, text, jsonb, text);

CREATE OR REPLACE FUNCTION public.create_pending_purchase(
  p_event_id uuid,
  p_ticket_type text,
  p_attendees jsonb,
  p_promo_code text DEFAULT NULL::text,
  p_payer_identifier text DEFAULT NULL::text
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
  v_payer_id     uuid;
  v_payer_norm   text;
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

  -- The existing-pending-request dedup lookup is scoped to payer_id too --
  -- a "someone else pays" request and a plain self-pay request for the
  -- exact same cart are never accidentally treated as the same request.
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

  -- expires_at is set ONLY when this is an actual payer request (v_payer_id
  -- IS NOT NULL) -- a normal self-pay purchase gets NULL, same as if this
  -- column never existed.
  INSERT INTO public.pending_purchases
    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at)
  VALUES
    (p_event_id, v_user_id, p_ticket_type, p_attendees, v_attendees_hash, v_promo_norm, v_amount_kobo, v_payment_ref, 'pending', v_payer_id,
     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END);

  RETURN jsonb_build_object('payment_ref', v_payment_ref, 'amount_kobo', v_amount_kobo);
END;
$function$
;

-- ── 5. finalize_pending_purchase: propagate payer_id onto every ticket
-- created, and treat an expired pending request as unpayable (never
-- creates tickets past expiry, regardless of what Paystack says -- the
-- caller path for a stale/late-return verify still sees a clean rejection
-- rather than a ticket materializing after the request was already
-- considered dead).
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

  -- CHANGED (was: auth.uid() <> v_row.user_id): the authorized payer may
  -- also legitimately call this (via the same server-side finalize step
  -- every payment goes through) -- never anyone else.
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_row.user_id AND auth.uid() IS DISTINCT FROM v_row.payer_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_row.status = 'completed' THEN
    SELECT array_agg(id) INTO v_ticket_ids FROM public.tickets
     WHERE payment_ref = p_payment_ref AND status = 'active';
  ELSE
    -- NEW: a cancelled/expired payment request can never be finalized into
    -- tickets, even if a stale Paystack callback still fires for it.
    IF v_row.status IN ('cancelled', 'expired') THEN
      RAISE EXCEPTION 'This payment request is no longer active (%)', v_row.status;
    END IF;
    -- NEW: lazily flip an overdue-but-still-'pending' request to 'expired'
    -- the moment anything tries to finalize it, rather than only on a
    -- read -- so it can never be paid past its window even by a payer who
    -- started checkout right before expiry and finishes just after.
    -- expires_at is NULL for a normal self-pay purchase (no payer_id was
    -- ever resolved), which never expires -- only an actual payer request
    -- has a real deadline to check here.
    IF v_row.expires_at IS NOT NULL AND v_row.expires_at < now() THEN
      UPDATE public.pending_purchases SET status = 'expired' WHERE id = v_row.id;
      RAISE EXCEPTION 'This payment request has expired';
    END IF;

    IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
      RAISE EXCEPTION 'purchases_disabled';
    END IF;

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

      -- CHANGED: payer_id added to both the column list and VALUES (from
      -- v_row.payer_id -- NULL for every existing/self-pay purchase, so
      -- every current ticket row's shape and content is unaffected).
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
$function$
;

-- ── 6. get_pending_purchase_owner now also returns payer_id, so the
-- webhook's ownership check can authorize either identity. Kept as one
-- function (not two) so the two ids can never be fetched out of sync with
-- each other for the same reference.
-- Postgres does not allow CREATE OR REPLACE to change a function's return
-- type (uuid -> TABLE(...) here) -- must drop the old single-uuid version
-- first. api/webhook/paystack.ts's caller is updated in the same code
-- change that ships this migration, so there is no window where the old
-- return shape is expected but missing.
DROP FUNCTION IF EXISTS public.get_pending_purchase_owner(text);

CREATE OR REPLACE FUNCTION public.get_pending_purchase_owner(p_payment_ref text)
 RETURNS TABLE(owner_id uuid, payer_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT user_id, payer_id FROM public.pending_purchases WHERE payment_ref = p_payment_ref;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_purchase_owner(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_pending_purchase_owner(text) TO project_admin;

-- ── 7. get_payment_request_details: the payer's own safe summary read,
-- called directly by the payer's client (not project_admin-only) --
-- returns only what's needed to decide whether to pay, never anything
-- else in pending_purchases. Callable by the resolved payer OR the
-- recipient (so the recipient's own "Payment Requests" list can show the
-- same status). Anyone else gets nothing (empty result), never an error
-- that would leak whether a reference exists.
CREATE OR REPLACE FUNCTION public.get_payment_request_details(p_payment_ref text)
 RETURNS TABLE(
   event_title text,
   event_image_url text,
   ticket_type text,
   attendee_count integer,
   amount_kobo bigint,
   recipient_name text,
   status text,
   is_expired boolean
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    e.title,
    e.image_url,
    pp.ticket_type,
    jsonb_array_length(pp.attendees),
    pp.amount_kobo,
    COALESCE(u.full_name, u.username),
    pp.status,
    (pp.status = 'pending' AND pp.expires_at IS NOT NULL AND pp.expires_at < now())
  FROM public.pending_purchases pp
  JOIN public.events e ON e.id = pp.event_id
  JOIN public.users u ON u.id = pp.user_id
  WHERE pp.payment_ref = p_payment_ref
    AND (pp.payer_id = (SELECT auth.uid()) OR pp.user_id = (SELECT auth.uid()));
$function$;

REVOKE ALL ON FUNCTION public.get_payment_request_details(text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_payment_request_details(text) TO authenticated, project_admin;

-- ── 8. cancel_payment_request: recipient-only, only while still pending.
-- Never touches a completed/already-paid request -- this is strictly a
-- pre-payment "never mind" action, not a refund path.
CREATE OR REPLACE FUNCTION public.cancel_payment_request(p_payment_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.pending_purchases%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.pending_purchases WHERE payment_ref = p_payment_ref FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_row.user_id <> (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN v_row.status;
  END IF;

  UPDATE public.pending_purchases SET status = 'cancelled' WHERE id = v_row.id;
  RETURN 'cancelled';
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_payment_request(text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.cancel_payment_request(text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.create_pending_purchase(uuid, text, jsonb, text, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid, text, jsonb, text, text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.finalize_pending_purchase(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_pending_purchase(text) TO project_admin;
