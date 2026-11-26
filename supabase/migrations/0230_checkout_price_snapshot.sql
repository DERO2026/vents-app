-- 0230: checkout price integrity (finding N1, docs/n1-checkout-price-snapshot.md).
--
-- Before: create_pending_purchase fixed only the order TOTAL (amount_kobo).
-- After the buyer paid, finalize_pending_purchase re-read the tier's CURRENT
-- price and the promo's CURRENT discount, wrote them to the tickets, and
-- confirm_ticket_payment / confirm_ticket_payment_via_wallet / refunds then
-- computed every amount from those tickets. A price change by the organizer
-- while checkout was open therefore:
--   * raised: card buyer charged but no ticket (amount_mismatch); wallet buyer
--     debited MORE than the agreed total;
--   * lowered: overpayment kept silently; wallet debited less; refunds at the
--     lower price;
--   * any change: a retry within 30 minutes was handed back the stale order,
--     which the checkout screen refuses ("price changed"), so the buyer was
--     stuck.
--
-- Fix (additive; the 0208 fee model 'v3_15_35' -- 1.5% attendee service fee,
-- 3.5% organizer deduction -- and its helper functions are NOT changed):
--   1. pending_purchases gets an immutable quote snapshot written by
--      create_pending_purchase: unit price, discount %, quantity, face total,
--      attendee service fee, discount amount, organizer deduction, currency,
--      tier identity (key) and time. amount_kobo stays the agreed total.
--      A trigger refuses any later change to the snapshot or to amount_kobo.
--   2. finalize_pending_purchase issues tickets at the SNAPSHOT unit price and
--      discount (never re-reads tier price or promo for a snapshotted order),
--      and refuses if the tier the order names is now a different tier
--      (different key). Capacity, event state and attendee checks unchanged.
--      Because confirm/wallet/refund all compute from the tickets with the
--      same 0208 helpers, they now produce exactly the agreed amounts.
--   3. confirm_ticket_payment and confirm_ticket_payment_via_wallet
--      cross-check the computed total against the order's agreed amount_kobo
--      and refuse (amount_mismatch / exception, nothing debited or credited)
--      if they ever differ.
--   4. No money starts moving against a stale quote:
--      initiate_ticket_payment_attempt (new Paystack attempt) and
--      confirm_ticket_payment_via_wallet refuse an order whose quote no
--      longer matches the current tier price / promo, with a clear message.
--      The order is NOT changed (an earlier attempt may still be completing
--      asynchronously and must still finalize at its agreed price).
--   5. create_pending_purchase reuses an open order only if its snapshot
--      equals the new quote, so after a price change a retry gets a fresh
--      order at the current price instead of being stuck.
--
-- Existing rows: orders created before 0230 have no snapshot (NULL). They
-- keep today's finalize/confirm behaviour exactly; the stale-quote guard
-- compares their stored amount_kobo with a fresh computation instead. No
-- ticket, payment, wallet, ledger or refund row is touched; no backfill.
--
-- Depends on 0203 + 0208 (fee helpers, fee_model) and 0229 (tier keys,
-- ticket_tier_find). Functions are patched IN PLACE from their live
-- definitions: every anchor must match exactly once, else the whole
-- migration refuses. Undo: supabase/rollback/undo_0230.sql.

BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.create_pending_purchase(uuid,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('public.finalize_pending_purchase(text)') IS NULL
     OR to_regprocedure('public.confirm_ticket_payment(text,bigint)') IS NULL
     OR to_regprocedure('public.confirm_ticket_payment_via_wallet(text)') IS NULL
     OR to_regprocedure('public.initiate_ticket_payment_attempt(text)') IS NULL
     OR to_regprocedure('public.ticket_fee_buyer_charge_kobo(numeric,integer,numeric,text)') IS NULL
     OR to_regprocedure('public.ticket_fee_organizer_deduction_total_kobo(numeric,integer,text)') IS NULL THEN
    RAISE EXCEPTION '0230 requires 0208 and 0060 (a ticket/fee function is missing); refusing';
  END IF;
  IF to_regprocedure('public.ticket_tier_find(jsonb,text)') IS NULL
     OR position('[0229]' IN pg_get_functiondef('public.finalize_pending_purchase(text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0230 requires 0229 (ticket tier identity); apply 0229 first';
  END IF;
END
$pre$;

-- ── 1. Snapshot columns (nullable: pre-0230 orders have none) ──────────────
ALTER TABLE public.pending_purchases
  ADD COLUMN IF NOT EXISTS quote_unit_price               numeric,
  ADD COLUMN IF NOT EXISTS quote_discount_pct             numeric,
  ADD COLUMN IF NOT EXISTS quote_quantity                 integer,
  ADD COLUMN IF NOT EXISTS quote_face_kobo                bigint,
  ADD COLUMN IF NOT EXISTS quote_service_fee_kobo         bigint,
  ADD COLUMN IF NOT EXISTS quote_discount_kobo            bigint,
  ADD COLUMN IF NOT EXISTS quote_organizer_deduction_kobo bigint,
  ADD COLUMN IF NOT EXISTS quote_currency                 text,
  ADD COLUMN IF NOT EXISTS quote_tier_key                 text,
  ADD COLUMN IF NOT EXISTS quoted_at                      timestamptz;

ALTER TABLE public.pending_purchases DROP CONSTRAINT IF EXISTS pending_purchases_quote_complete;
ALTER TABLE public.pending_purchases ADD CONSTRAINT pending_purchases_quote_complete CHECK (
  quote_unit_price IS NULL
  OR (quote_unit_price >= 0
      AND quote_discount_pct IS NOT NULL AND quote_discount_pct >= 0 AND quote_discount_pct <= 100
      AND quote_quantity BETWEEN 1 AND 10
      AND quote_face_kobo IS NOT NULL AND quote_service_fee_kobo IS NOT NULL
      AND quote_discount_kobo IS NOT NULL AND quote_organizer_deduction_kobo IS NOT NULL
      AND quote_currency = 'NGN' AND quoted_at IS NOT NULL));

-- Once written, the agreed quote never changes.
CREATE OR REPLACE FUNCTION public.pending_purchases_quote_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- [0230]
  IF OLD.quote_unit_price IS NOT NULL AND (
       NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo
    OR NEW.fee_model IS DISTINCT FROM OLD.fee_model
    OR NEW.ticket_type IS DISTINCT FROM OLD.ticket_type
    OR NEW.attendees IS DISTINCT FROM OLD.attendees
    OR NEW.promo_code IS DISTINCT FROM OLD.promo_code
    OR NEW.quote_unit_price IS DISTINCT FROM OLD.quote_unit_price
    OR NEW.quote_discount_pct IS DISTINCT FROM OLD.quote_discount_pct
    OR NEW.quote_quantity IS DISTINCT FROM OLD.quote_quantity
    OR NEW.quote_face_kobo IS DISTINCT FROM OLD.quote_face_kobo
    OR NEW.quote_service_fee_kobo IS DISTINCT FROM OLD.quote_service_fee_kobo
    OR NEW.quote_discount_kobo IS DISTINCT FROM OLD.quote_discount_kobo
    OR NEW.quote_organizer_deduction_kobo IS DISTINCT FROM OLD.quote_organizer_deduction_kobo
    OR NEW.quote_currency IS DISTINCT FROM OLD.quote_currency
    OR NEW.quote_tier_key IS DISTINCT FROM OLD.quote_tier_key
    OR NEW.quoted_at IS DISTINCT FROM OLD.quoted_at) THEN
    RAISE EXCEPTION 'An order''s agreed price cannot be changed after it is created';
  END IF;
  IF OLD.quote_unit_price IS NULL AND NEW.quote_unit_price IS NOT NULL THEN
    RAISE EXCEPTION 'A price snapshot can only be written when the order is created';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.pending_purchases_quote_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pending_purchases_quote_immutable ON public.pending_purchases;
CREATE TRIGGER trg_pending_purchases_quote_immutable
  BEFORE UPDATE ON public.pending_purchases
  FOR EACH ROW EXECUTE FUNCTION public.pending_purchases_quote_immutable();

-- ── 2. Is an open order's quote still the current price? ───────────────────
-- NULL = yes (or the order is not open: nothing to guard). Otherwise the
-- buyer-facing reason. Used only BEFORE money moves (new Paystack attempt,
-- wallet payment); never after a charge.
CREATE FUNCTION public.ticket_order_quote_problem(p_payment_ref text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row    public.pending_purchases%ROWTYPE;
  v_event  record;
  v_tier   jsonb;
  v_unit   numeric;
  v_disc   numeric := 0;
  v_promo  public.promo_codes;
  v_count  integer;
BEGIN
  -- [0230]
  SELECT * INTO v_row FROM public.pending_purchases WHERE payment_ref = p_payment_ref;
  IF NOT FOUND OR v_row.status <> 'pending' THEN
    RETURN NULL;
  END IF;
  SELECT price, ticket_types INTO v_event FROM public.events WHERE id = v_row.event_id;
  IF NOT FOUND THEN
    RETURN 'This event is no longer available.';
  END IF;
  IF v_event.ticket_types IS NOT NULL AND jsonb_typeof(v_event.ticket_types) = 'array' AND jsonb_array_length(v_event.ticket_types) > 0 THEN
    v_tier := public.ticket_tier_find(v_event.ticket_types, v_row.ticket_type);
    IF v_tier IS NULL THEN
      RETURN 'This ticket type is no longer available. Go back and choose a ticket again.';
    END IF;
    IF v_row.quote_tier_key IS NOT NULL
       AND COALESCE(NULLIF(btrim(v_tier->>'key'), ''), v_tier->>'name') IS DISTINCT FROM v_row.quote_tier_key THEN
      RETURN 'This ticket type has changed since you started checkout. Go back and choose a ticket again.';
    END IF;
    v_unit := (v_tier->>'price')::numeric;
  ELSE
    v_unit := COALESCE(v_event.price, 0);
  END IF;
  IF v_row.promo_code IS NOT NULL THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
    IF NOT FOUND OR NOT v_promo.is_active
       OR (v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now())
       OR (v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses) THEN
      RETURN 'The promo code on this order is no longer available. Go back to see the current total.';
    END IF;
    v_disc := v_promo.discount_percentage;
  END IF;
  IF v_row.quote_unit_price IS NOT NULL THEN
    IF v_unit IS DISTINCT FROM v_row.quote_unit_price OR v_disc IS DISTINCT FROM v_row.quote_discount_pct THEN
      RETURN 'The price of this ticket has changed since you started checkout. Go back to see the new total.';
    END IF;
  ELSE
    -- Pre-0230 order: compare its stored total with a fresh computation.
    v_count := jsonb_array_length(v_row.attendees);
    IF v_unit IS NULL OR v_count < 1
       OR public.ticket_fee_buyer_charge_kobo(v_unit * v_count, v_count, v_disc, v_row.fee_model) IS DISTINCT FROM v_row.amount_kobo THEN
      RETURN 'The price of this ticket has changed since you started checkout. Go back to see the new total.';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.ticket_order_quote_problem(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_order_quote_problem(text) TO project_admin;

-- ── 3. In-place patches ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.vents_0230_patch(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  IF position('[0230]' IN v_def) > 0 THEN
    RAISE EXCEPTION '0230: % is already patched; refusing to run twice', p_sig;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION '0230: % is not the expected version (anchor % not found exactly once); refusing to patch', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_0230_patch('public.create_pending_purchase(uuid,text,jsonb,text,text)', ARRAY[
  ARRAY[$a$     AND fee_model = 'v3_15_35'
     AND created_at > now() - interval '30 minutes'$a$, $a$     AND fee_model = 'v3_15_35'
     AND created_at > now() - interval '30 minutes'
     -- [0230] reuse only an order whose agreed quote equals today's quote
     AND amount_kobo = v_amount_kobo
     AND quote_unit_price = v_unit_price
     AND quote_discount_pct = v_discount_pct$a$],
  ARRAY[$a$    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at, fee_model)$a$,
        $a$    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at, fee_model,
     quote_unit_price, quote_discount_pct, quote_quantity, quote_face_kobo, quote_service_fee_kobo, quote_discount_kobo,
     quote_organizer_deduction_kobo, quote_currency, quote_tier_key, quoted_at)$a$],
  ARRAY[$a$     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END, 'v3_15_35');$a$,
        $a$     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END, 'v3_15_35',
     -- [0230] immutable quote snapshot (same 0208 helpers as amount_kobo)
     v_unit_price, v_discount_pct, v_count,
     v_count * round(v_unit_price * 100)::bigint,
     public.ticket_fee_buyer_charge_kobo(v_unit_price * v_count, v_count, 0, 'v3_15_35') - v_count * round(v_unit_price * 100)::bigint,
     public.ticket_fee_buyer_charge_kobo(v_unit_price * v_count, v_count, 0, 'v3_15_35') - v_amount_kobo,
     public.ticket_fee_organizer_deduction_total_kobo(v_unit_price * v_count, v_count, 'v3_15_35'),
     'NGN',
     CASE WHEN v_ticket_obj IS NOT NULL THEN COALESCE(NULLIF(btrim(v_ticket_obj->>'key'), ''), v_ticket_obj->>'name') END,
     now());$a$]
]);

SELECT pg_temp.vents_0230_patch('public.finalize_pending_purchase(text)', ARRAY[
  ARRAY[$a$    IF v_row.promo_code IS NOT NULL THEN
      SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
      IF FOUND THEN
        v_discount_pct := v_promo.discount_percentage;
      END IF;
    END IF;$a$, $a$    IF v_row.promo_code IS NOT NULL THEN
      SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
      IF FOUND THEN
        v_discount_pct := v_promo.discount_percentage;
      END IF;
    END IF;

    -- [0230] A snapshotted order is issued at the price and discount the
    -- buyer agreed to, never the tier's or promo's current values.
    IF v_row.quote_unit_price IS NOT NULL THEN
      IF v_row.quote_tier_key IS NOT NULL AND v_ticket_obj IS NOT NULL
         AND COALESCE(NULLIF(btrim(v_ticket_obj->>'key'), ''), v_ticket_obj->>'name') IS DISTINCT FROM v_row.quote_tier_key THEN
        RAISE EXCEPTION 'The ticket type for this order has changed since it was created';
      END IF;
      v_unit_price := v_row.quote_unit_price;
      v_discount_pct := v_row.quote_discount_pct;
    END IF;$a$]
]);

SELECT pg_temp.vents_0230_patch('public.confirm_ticket_payment(text,bigint)', ARRAY[
  ARRAY[$a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);
  IF p_amount_kobo < v_expected_kobo THEN$a$, $a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);
  -- [0230] The order's agreed total is authoritative. If the tickets ever
  -- disagree with it, confirm nothing (recorded as a payment exception).
  IF EXISTS (SELECT 1 FROM public.pending_purchases pp
              WHERE pp.payment_ref = p_reference AND pp.quote_unit_price IS NOT NULL
                AND pp.amount_kobo IS DISTINCT FROM v_expected_kobo) THEN
    RETURN 'amount_mismatch:' || (SELECT pp.amount_kobo FROM public.pending_purchases pp WHERE pp.payment_ref = p_reference)::text || ':' || p_amount_kobo::text;
  END IF;
  IF p_amount_kobo < v_expected_kobo THEN$a$]
]);

SELECT pg_temp.vents_0230_patch('public.confirm_ticket_payment_via_wallet(text)', ARRAY[
  ARRAY[$a$  v_deduction_kobo  bigint;
BEGIN$a$, $a$  v_deduction_kobo  bigint;
  v_quote_problem   text;  -- [0230]
BEGIN$a$],
  ARRAY[$a$  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);$a$, $a$  -- [0230] Never start a wallet charge against a quote that is no longer current.
  v_quote_problem := public.ticket_order_quote_problem(p_payment_ref);
  IF v_quote_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_quote_problem;
  END IF;

  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);$a$],
  ARRAY[$a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)$a$, $a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);
  -- [0230] Debit exactly the order's agreed total; refuse if the tickets disagree.
  IF EXISTS (SELECT 1 FROM public.pending_purchases pp
              WHERE pp.payment_ref = p_payment_ref AND pp.quote_unit_price IS NOT NULL
                AND pp.amount_kobo IS DISTINCT FROM v_expected_kobo) THEN
    RAISE EXCEPTION 'This order''s total does not match its tickets; nothing was charged';
  END IF;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)$a$]
]);

SELECT pg_temp.vents_0230_patch('public.initiate_ticket_payment_attempt(text)', ARRAY[
  ARRAY[$a$  v_ref := 'PSK-' || replace(gen_random_uuid()::text, '-', '');$a$, $a$  -- [0230] Never start a card charge against a quote that is no longer
  -- current. The order itself is left unchanged.
  v_ref := public.ticket_order_quote_problem(v_row.payment_ref);
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION '%', v_ref;
  END IF;

  v_ref := 'PSK-' || replace(gen_random_uuid()::text, '-', '');$a$]
]);

COMMIT;
