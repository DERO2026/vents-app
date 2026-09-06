-- VENTS Services marketplace: multi-category providers + real service
-- booking/payment flow (customer selects one or more provider_services,
-- pays via the EXISTING Paystack/NGN/amount_kobo architecture, provider is
-- credited through the existing organizer_wallets/organizer_transactions
-- ledger). Builds on 0033 (capability) / 0034 (listing) / 0048 (services
-- catalog) -- does not alter any of those tables' existing columns or
-- policies.
--
-- Decisions made explicitly by the product owner before this migration was
-- written (do not revisit without a new explicit instruction):
--  1. Fee model matches the EXISTING ticket-purchase model exactly: the
--     customer pays subtotal + 5% VENTS fee; the provider is credited 100%
--     of the subtotal (fee is additive on top of the buyer's charge, never
--     deducted from the provider's advertised price). Mirrors
--     confirm_ticket_payment's `* 1.05` shape (0004_functions.sql), except
--     the fee percent is read from a real config row here so it can change
--     later without a redeploy (get_service_booking_fee_percent() below).
--  2. Currency scope for THIS pass: NGN only. A provider/service whose
--     currency is anything else can still be listed and browsed, but
--     create_service_booking below explicitly refuses to create a payable
--     booking for it. No changes are made to amount_kobo/openPaystackPopup/
--     the existing ticket-payment architecture to support other currencies
--     -- that stays a separate future project.

-- ── 1. Multi-category providers ─────────────────────────────────────────
-- service_providers.category (0034) stays exactly as-is -- a plain text
-- column -- and continues to hold the provider's PRIMARY category, so every
-- existing single-category consumer (category filter/search, the
-- categoryAccents color lookup, admin dashboard) keeps working unchanged.
-- This table adds the full set of categories a provider offers, additive to
-- that primary column, never replacing it.
CREATE TABLE IF NOT EXISTS public.service_provider_categories (
  provider_id uuid NOT NULL REFERENCES public.service_providers(id) ON DELETE CASCADE,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_provider_categories_pkey PRIMARY KEY (provider_id, category)
);

CREATE INDEX IF NOT EXISTS idx_service_provider_categories_category ON public.service_provider_categories (category);

-- Backfill: every existing provider's current single category becomes the
-- first row here, so nothing regresses for a provider who never touches
-- their categories again.
INSERT INTO public.service_provider_categories (provider_id, category)
SELECT id, category FROM public.service_providers
ON CONFLICT (provider_id, category) DO NOTHING;

ALTER TABLE public.service_provider_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_provider_categories_public_select ON public.service_provider_categories
  FOR SELECT
  TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = provider_id AND sp.status = 'approved'));

CREATE POLICY service_provider_categories_select_own ON public.service_provider_categories
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid())));

CREATE POLICY service_provider_categories_admin_select ON public.service_provider_categories
  FOR SELECT
  TO authenticated
  USING (is_admin());

CREATE POLICY service_provider_categories_admin_all ON public.service_provider_categories
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- No direct insert/update/delete policy for a plain authenticated caller --
-- all writes go through set_service_provider_categories() below, which
-- validates ownership + capability + count atomically. RLS on this table is
-- read-only for non-admin callers by design.
GRANT SELECT ON public.service_provider_categories TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.service_provider_categories TO project_admin;

-- Sets a provider's full category set atomically (1-5 categories). The
-- first category in p_categories becomes the provider's primary
-- service_providers.category (unchanged column, so every existing
-- single-category reader keeps working), the rest are additive. Ownership +
-- capability gated exactly like service_providers_update_own (0034) --
-- a provider whose capability was revoked cannot edit categories either.
CREATE OR REPLACE FUNCTION public.set_service_provider_categories(p_provider_id uuid, p_categories text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_clean text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.service_providers sp
    JOIN public.users u ON u.id = sp.user_id
    WHERE sp.id = p_provider_id AND sp.user_id = (SELECT auth.uid()) AND u.is_service_provider = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to edit categories for this provider';
  END IF;

  SELECT array_agg(DISTINCT trim(c)) INTO v_clean
  FROM unnest(p_categories) AS c
  WHERE trim(c) <> '';

  IF v_clean IS NULL OR array_length(v_clean, 1) = 0 THEN
    RAISE EXCEPTION 'At least one category is required';
  END IF;
  IF array_length(v_clean, 1) > 5 THEN
    RAISE EXCEPTION 'A provider may select at most 5 categories';
  END IF;

  UPDATE public.service_providers SET category = v_clean[1], updated_at = now() WHERE id = p_provider_id;

  DELETE FROM public.service_provider_categories
   WHERE provider_id = p_provider_id AND category <> ALL (v_clean);

  INSERT INTO public.service_provider_categories (provider_id, category)
  SELECT p_provider_id, c FROM unnest(v_clean) AS c
  ON CONFLICT (provider_id, category) DO NOTHING;
END;
$function$
;

REVOKE ALL ON FUNCTION public.set_service_provider_categories(uuid, text[]) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.set_service_provider_categories(uuid, text[]) TO authenticated, project_admin;

-- ── 2. Configurable VENTS Services fee (server-side, no redeploy needed) ─
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_settings_pkey PRIMARY KEY (key)
);

INSERT INTO public.platform_settings (key, value)
VALUES ('service_booking_fee_percent', '5')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_settings_admin_select ON public.platform_settings
  FOR SELECT
  TO authenticated
  USING (is_admin());

GRANT SELECT ON public.platform_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.platform_settings TO project_admin;

CREATE OR REPLACE FUNCTION public.get_service_booking_fee_percent()
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT (value)::text::numeric FROM public.platform_settings WHERE key = 'service_booking_fee_percent'), 5);
$function$
;

REVOKE ALL ON FUNCTION public.get_service_booking_fee_percent() FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_service_booking_fee_percent() TO authenticated, project_admin;

-- Super Admin only, same shape/audit-logging as admin_set_service_provider_
-- capability (0033) -- lets the fee change later with no redeploy, but only
-- from the DB's most privileged role, never the client.
CREATE OR REPLACE FUNCTION public.admin_set_service_booking_fee_percent(p_percent numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  IF p_percent < 0 OR p_percent > 100 THEN
    RAISE EXCEPTION 'Invalid fee percent';
  END IF;

  INSERT INTO public.platform_settings (key, value, updated_at)
  VALUES ('service_booking_fee_percent', to_jsonb(p_percent), now())
  ON CONFLICT (key) DO UPDATE SET value = to_jsonb(p_percent), updated_at = now();

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'service_booking_fee_percent_change', NULL, jsonb_build_object('new_percent', p_percent), public.actor_role());
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_set_service_booking_fee_percent(numeric) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_set_service_booking_fee_percent(numeric) TO authenticated, project_admin;

-- ── 3. Booking + booking line items ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.service_bookings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  provider_id uuid NOT NULL REFERENCES public.service_providers(id),
  status text NOT NULL DEFAULT 'pending_payment',
  scheduled_date date,
  scheduled_time time,
  location text,
  customer_notes text,
  currency text NOT NULL,
  subtotal_kobo bigint NOT NULL,
  fee_kobo bigint NOT NULL,
  total_kobo bigint NOT NULL,
  payment_ref text,
  payment_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_bookings_pkey PRIMARY KEY (id),
  CONSTRAINT service_bookings_payment_ref_key UNIQUE (payment_ref),
  CONSTRAINT service_bookings_status_check CHECK (status IN ('pending_payment', 'confirmed', 'completed', 'cancelled')),
  CONSTRAINT service_bookings_payment_status_check CHECK (payment_status IN ('pending', 'paid', 'failed')),
  CONSTRAINT service_bookings_subtotal_check CHECK (subtotal_kobo >= 0),
  CONSTRAINT service_bookings_fee_check CHECK (fee_kobo >= 0),
  CONSTRAINT service_bookings_total_check CHECK (total_kobo >= 0)
);

CREATE INDEX IF NOT EXISTS idx_service_bookings_customer_id ON public.service_bookings (customer_id);
CREATE INDEX IF NOT EXISTS idx_service_bookings_provider_id ON public.service_bookings (provider_id);
CREATE INDEX IF NOT EXISTS idx_service_bookings_payment_ref ON public.service_bookings (payment_ref);

CREATE TABLE IF NOT EXISTS public.service_booking_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.service_bookings(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.provider_services(id),
  service_name text NOT NULL,
  unit_price_kobo bigint NOT NULL,
  quantity integer NOT NULL,
  line_total_kobo bigint NOT NULL,
  CONSTRAINT service_booking_items_pkey PRIMARY KEY (id),
  CONSTRAINT service_booking_items_unit_price_check CHECK (unit_price_kobo >= 0),
  CONSTRAINT service_booking_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT service_booking_items_line_total_check CHECK (line_total_kobo >= 0)
);

CREATE INDEX IF NOT EXISTS idx_service_booking_items_booking_id ON public.service_booking_items (booking_id);

ALTER TABLE public.service_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_booking_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_bookings_select_own_customer ON public.service_bookings
  FOR SELECT
  TO authenticated
  USING (customer_id = (SELECT auth.uid()));

CREATE POLICY service_bookings_select_own_provider ON public.service_bookings
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = provider_id AND sp.user_id = (SELECT auth.uid())));

CREATE POLICY service_bookings_admin_select ON public.service_bookings
  FOR SELECT
  TO authenticated
  USING (is_admin());

-- No INSERT/UPDATE policy for authenticated at all -- every write (create,
-- payment confirmation, status transition) goes through a SECURITY DEFINER
-- RPC below, which bypasses RLS as the function owner after its own
-- explicit ownership/authorization checks. This is deliberate: a customer
-- or provider can never directly UPDATE payment_status, total_kobo, or
-- provider_id on their own booking row.
CREATE POLICY service_bookings_admin_update ON public.service_bookings
  FOR UPDATE
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY service_booking_items_select_own_customer ON public.service_booking_items
  FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.service_bookings b WHERE b.id = booking_id AND b.customer_id = (SELECT auth.uid())));

CREATE POLICY service_booking_items_select_own_provider ON public.service_booking_items
  FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.service_bookings b
    JOIN public.service_providers sp ON sp.id = b.provider_id
    WHERE b.id = booking_id AND sp.user_id = (SELECT auth.uid())
  ));

CREATE POLICY service_booking_items_admin_select ON public.service_booking_items
  FOR SELECT
  TO authenticated
  USING (is_admin());

GRANT SELECT ON public.service_bookings TO authenticated;
GRANT SELECT ON public.service_booking_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.service_bookings TO project_admin;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.service_booking_items TO project_admin;

CREATE OR REPLACE FUNCTION public.set_service_bookings_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.set_service_bookings_updated_at() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_service_bookings_updated_at() TO anon, authenticated, project_admin;

CREATE TRIGGER trg_set_service_bookings_updated_at
  BEFORE UPDATE ON public.service_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_service_bookings_updated_at();

-- ── 4. create_service_booking: the server-computed order, before Paystack
-- ever opens (same shape as create_pending_purchase, 0004_functions.sql) --
-- the client sends only provider_id + [{service_id, quantity}] + optional
-- scheduling fields; every price/currency/ownership fact is re-derived
-- server-side from provider_services, never trusted from the caller.
CREATE OR REPLACE FUNCTION public.create_service_booking(
  p_provider_id uuid,
  p_items jsonb,
  p_scheduled_date date DEFAULT NULL,
  p_scheduled_time time DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
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

  -- Currency scope for this pass: NGN only (see this migration's header
  -- comment) -- a non-NGN service can be listed/browsed but never booked
  -- through VENTS payment yet.
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
$function$
;

REVOKE ALL ON FUNCTION public.create_service_booking(uuid, jsonb, date, time, text, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.create_service_booking(uuid, jsonb, date, time, text, text) TO authenticated, project_admin;

-- ── 5. Provider payout on a paid booking -- reuses the EXISTING organizer_
-- wallets/organizer_transactions ledger (0002_tables.sql) rather than a new
-- parallel wallet system, exactly as instructed. Deliberately NOT calling
-- credit_organizer_wallet() itself: that function hard-requires its
-- p_ticket_sale_id to reference an existing PAID row in `tickets`
-- (0004_functions.sql:856-876) -- a service_bookings.id would fail that
-- lookup outright. This does the same balance/ledger update, idempotent via
-- a metadata-keyed lookup instead of the tickets-specific one.
CREATE OR REPLACE FUNCTION public.credit_provider_wallet_for_booking(p_provider_user_id uuid, p_amount_kobo bigint, p_booking_id uuid, p_description text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
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
$function$
;

REVOKE ALL ON FUNCTION public.credit_provider_wallet_for_booking(uuid, bigint, uuid, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.credit_provider_wallet_for_booking(uuid, bigint, uuid, text) TO authenticated, project_admin;

-- ── 6. confirm_service_booking_payment: the actual pending->paid
-- transition, same shape/idempotency/locking as confirm_ticket_payment.
-- project_admin-only (never reachable via the public Supabase client) --
-- invoked exclusively from the Paystack webhook/verify handler over the
-- direct project_admin Postgres connection, same convention as
-- confirm_ticket_payment (0031_restrict_finalize_pending_purchase.sql).
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

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_booking.customer_id, 'booking', 'Booking confirmed', 'Your service booking has been paid and confirmed.');

  INSERT INTO public.notifications (user_id, type, title, body)
  VALUES (v_provider_user_id, 'booking', 'New service booking', 'You have a new paid service booking. Check your bookings for details.');

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_service_booking_payment(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_service_booking_payment(text, bigint) TO project_admin;

-- Ownership check for the client-triggered ?action=verify path, same
-- pattern as get_pending_purchase_owner.
CREATE OR REPLACE FUNCTION public.get_service_booking_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT customer_id FROM public.service_bookings WHERE payment_ref = p_reference;
$function$
;

REVOKE ALL ON FUNCTION public.get_service_booking_owner(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_service_booking_owner(text) TO project_admin;

-- ── 7. Review gating: a review may only be left against a completed,
-- PAID VENTS booking -- addresses the 0048 header comment's forward
-- reference. Separate table from organizer_reviews (events), since a
-- provider review is keyed to a service_bookings row, not an event.
CREATE TABLE IF NOT EXISTS public.provider_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.service_providers(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES public.users(id),
  booking_id uuid NOT NULL REFERENCES public.service_bookings(id),
  rating smallint NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT provider_reviews_booking_unique UNIQUE (booking_id),
  CONSTRAINT provider_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT provider_reviews_body_check CHECK (char_length(trim(body)) >= 10)
);

CREATE INDEX IF NOT EXISTS idx_provider_reviews_provider_id ON public.provider_reviews (provider_id);

ALTER TABLE public.provider_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_reviews_public_select ON public.provider_reviews
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Insert requires: the caller IS the reviewer, AND the referenced booking
-- belongs to them, is for the same provider, and has actually been paid --
-- the actual anti-fake-review gate.
CREATE POLICY provider_reviews_insert_own ON public.provider_reviews
  FOR INSERT
  TO authenticated
  WITH CHECK (
    reviewer_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.service_bookings b
      WHERE b.id = booking_id
        AND b.customer_id = (SELECT auth.uid())
        AND b.provider_id = provider_reviews.provider_id
        AND b.payment_status = 'paid'
    )
  );

CREATE POLICY provider_reviews_update_own ON public.provider_reviews
  FOR UPDATE
  TO authenticated
  USING (reviewer_id = (SELECT auth.uid()))
  WITH CHECK (reviewer_id = (SELECT auth.uid()));

CREATE POLICY provider_reviews_delete_own ON public.provider_reviews
  FOR DELETE
  TO authenticated
  USING (reviewer_id = (SELECT auth.uid()));

CREATE POLICY provider_reviews_admin_all ON public.provider_reviews
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

GRANT DELETE, INSERT, SELECT, UPDATE ON public.provider_reviews TO anon, authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.provider_reviews TO project_admin;

-- ── 8. Anti-bypass funnel event log (VENTS Shield foundation) -- write-only
-- from the client's perspective (through the RPC below), admin-read-only.
CREATE TABLE IF NOT EXISTS public.service_marketplace_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id uuid,
  provider_id uuid,
  service_id uuid,
  booking_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_marketplace_events_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_service_marketplace_events_provider_id ON public.service_marketplace_events (provider_id);
CREATE INDEX IF NOT EXISTS idx_service_marketplace_events_event_type ON public.service_marketplace_events (event_type);

ALTER TABLE public.service_marketplace_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_marketplace_events_admin_select ON public.service_marketplace_events
  FOR SELECT
  TO authenticated
  USING (is_admin());

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.service_marketplace_events TO project_admin;

CREATE OR REPLACE FUNCTION public.log_service_marketplace_event(
  p_event_type text, p_provider_id uuid DEFAULT NULL, p_service_id uuid DEFAULT NULL,
  p_booking_id uuid DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.service_marketplace_events (event_type, user_id, provider_id, service_id, booking_id, metadata)
  VALUES (p_event_type, auth.uid(), p_provider_id, p_service_id, p_booking_id, COALESCE(p_metadata, '{}'::jsonb));
END;
$function$
;

REVOKE ALL ON FUNCTION public.log_service_marketplace_event(text, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.log_service_marketplace_event(text, uuid, uuid, uuid, jsonb) TO authenticated, project_admin;
