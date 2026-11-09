-- 0208: ticket fees 1.5% attendee service fee + 3.5% organizer platform deduction.
--
-- Owner instruction 2026-11-08 ("VENTS — urgent production fixes", item 1):
--   attendee service fee   1.5% of the ticket price, shown at checkout;
--   organizer deduction    3.5% of the ticket price, deducted per ticket;
--   VENTS revenue          5% per ticket in total.
-- This replaces the 4% + 5% model 0203 introduced (never applied to
-- production). Applied in the window right after 0203 (runbook W6d), so no
-- ticket is ever sold on the 4% + 5% model.
--
-- New fee model 'v3_15_35'. Every amount is computed PER TICKET in kobo and
-- multiplied by the quantity, so a purchase, its refunds (per ticket) and the
-- organizer's analytics always agree to the kobo:
--   face F            = round(price * 100)                       (kobo, per ticket)
--   attendee fee      = round(F * 15 / 1000)                     (1.5%, half-up)
--   promo discount    = round(F * discount_pct / 100)            (on the face, as before)
--   attendee pays     = qty * (F + attendee fee - promo discount)
--   organizer deduction = round(F * 35 / 1000)                     (3.5%, half-up)
--   organizer gets    = qty * (F - organizer deduction)
-- Tickets keep the fee model they were bought under: legacy_5 rows (before
-- 0203) keep their arithmetic unchanged. Nothing already recorded is
-- rewritten; no balance changes.
--
-- The 4% + 5% model (v2_4_5) that 0203 introduced is REMOVED from the final
-- state: purchases are paused from W1 until this migration is in, so no
-- ticket can have been sold on it; this migration refuses to run if one was,
-- then allows only legacy_5 and v3_15_35 and drops every v2_4_5 branch.
--
-- Prerequisite: 0203. Each patched function must still contain exactly the
-- text 0203 put there, or this migration stops (no partial apply: one
-- transaction). Idempotent: a second run changes nothing.

DO $pre$
BEGIN
  IF to_regprocedure('public.ticket_fee_organizer_deduction_kobo(bigint,text)') IS NULL THEN
    RAISE EXCEPTION '0208 requires 0203 (ticket_fee_organizer_deduction_kobo is missing)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- Fee model column: only legacy_5 (before 0203) and v3_15_35 (1.5% + 3.5%);
-- new rows default to v3_15_35. The 4% + 5% model is never allowed.
-- ---------------------------------------------------------------------------
DO $no_v2$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tickets WHERE fee_model = 'v2_4_5')
     OR EXISTS (SELECT 1 FROM public.pending_purchases WHERE fee_model = 'v2_4_5') THEN
    RAISE EXCEPTION '0208: tickets or purchases exist on the unapproved 4%% + 5%% model (v2_4_5); purchases must stay paused from W1 until 0208. Stop and investigate.';
  END IF;
END
$no_v2$;
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_fee_model_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_fee_model_check CHECK (fee_model IN ('legacy_5', 'v3_15_35'));
ALTER TABLE public.pending_purchases DROP CONSTRAINT IF EXISTS pending_purchases_fee_model_check;
ALTER TABLE public.pending_purchases ADD CONSTRAINT pending_purchases_fee_model_check CHECK (fee_model IN ('legacy_5', 'v3_15_35'));
ALTER TABLE public.tickets ALTER COLUMN fee_model SET DEFAULT 'v3_15_35';
ALTER TABLE public.pending_purchases ALTER COLUMN fee_model SET DEFAULT 'v3_15_35';

-- ---------------------------------------------------------------------------
-- Fee helpers
-- ---------------------------------------------------------------------------
-- Kept for callers that still use a multiplier (display/analytics of older models).
CREATE OR REPLACE FUNCTION public.ticket_fee_buyer_multiplier(p_fee_model text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  RETURN CASE p_fee_model WHEN 'v3_15_35' THEN 1.015 WHEN 'legacy_5' THEN 1.05
         ELSE NULL END;
END;
$function$;

-- Organizer platform deduction on ONE ticket's face value (kobo).
CREATE OR REPLACE FUNCTION public.ticket_fee_organizer_deduction_kobo(p_face_kobo bigint, p_fee_model text)
 RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_fee_model = 'v3_15_35' THEN
    RETURN round(GREATEST(COALESCE(p_face_kobo, 0), 0) * 35 / 1000.0)::bigint;
  ELSIF p_fee_model = 'legacy_5' THEN
    RETURN 0;
  END IF;
  RAISE EXCEPTION 'Unknown ticket fee model: %', p_fee_model;
END;
$function$;

-- What the attendee pays for p_count tickets whose faces sum to p_face_total
-- (naira). v3_15_35 is computed per ticket and multiplied by the quantity;
-- older models keep their original whole-purchase formula exactly.
CREATE OR REPLACE FUNCTION public.ticket_fee_buyer_charge_kobo(p_face_total numeric, p_count integer, p_discount_pct numeric, p_fee_model text)
 RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_face_kobo bigint;
BEGIN
  IF p_fee_model = 'v3_15_35' THEN
    IF COALESCE(p_count, 0) < 1 THEN
      RAISE EXCEPTION 'ticket_fee_buyer_charge_kobo: quantity must be at least 1';
    END IF;
    v_face_kobo := round(GREATEST(COALESCE(p_face_total, 0), 0) / p_count * 100)::bigint;
    RETURN p_count * GREATEST(0,
      v_face_kobo
      + round(v_face_kobo * 15 / 1000.0)::bigint
      - round(v_face_kobo * COALESCE(p_discount_pct, 0) / 100.0)::bigint);
  END IF;
  IF p_fee_model = 'legacy_5' THEN
    RETURN round(p_face_total * (public.ticket_fee_buyer_multiplier(p_fee_model) - COALESCE(p_discount_pct, 0) / 100) * 100)::bigint;
  END IF;
  RAISE EXCEPTION 'Unknown ticket fee model: %', p_fee_model;
END;
$function$;

-- Organizer platform deduction for a whole purchase: per ticket, times the quantity.
CREATE OR REPLACE FUNCTION public.ticket_fee_organizer_deduction_total_kobo(p_face_total numeric, p_count integer, p_fee_model text)
 RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_fee_model = 'v3_15_35' THEN
    IF COALESCE(p_count, 0) < 1 THEN
      RAISE EXCEPTION 'ticket_fee_organizer_deduction_total_kobo: quantity must be at least 1';
    END IF;
    RETURN p_count * public.ticket_fee_organizer_deduction_kobo(round(GREATEST(COALESCE(p_face_total, 0), 0) / p_count * 100)::bigint, p_fee_model);
  END IF;
  RETURN public.ticket_fee_organizer_deduction_kobo(floor(COALESCE(p_face_total, 0) * 100)::bigint, p_fee_model);
END;
$function$;

-- New purchases get v3_15_35; a ticket inherits its purchase's model and it never changes.
CREATE OR REPLACE FUNCTION public.tickets_fee_model_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'tickets' THEN
      NEW.fee_model := COALESCE(
        (SELECT pp.fee_model FROM public.pending_purchases pp WHERE pp.payment_ref = NEW.payment_ref),
        'v3_15_35');
    ELSE
      NEW.fee_model := 'v3_15_35';
    END IF;
  ELSIF NEW.fee_model IS DISTINCT FROM OLD.fee_model THEN
    RAISE EXCEPTION 'fee_model cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;

-- 0201's nominal fee (what VENTS gives up on a refund), per model:
-- legacy 5% attendee fee; v3 1.5% attendee fee + 3.5% organizer deduction = 5%.
CREATE OR REPLACE FUNCTION public.earn_ticket_nominal_fee_kobo(p_amount numeric, p_fee_model text)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT GREATEST(0, ceil(COALESCE(p_amount, 0) * CASE WHEN p_fee_model IN ('legacy_5', 'v3_15_35') THEN 5 END))::bigint;
$function$;

-- The ONE fee quote every screen displays (checkout, ticket selection, the
-- event page, Create Event's "you earn"): the same helpers that charge,
-- settle and refund, so a displayed amount can never differ from a charged
-- one. Rates are derived from the helpers, not restated. Read-only; callable
-- by anyone (ticket prices are public).
CREATE OR REPLACE FUNCTION public.ticket_fee_quote(p_unit_price numeric, p_quantity integer DEFAULT 1, p_discount_pct numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_model constant text := 'v3_15_35';
  v_qty integer := COALESCE(p_quantity, 1);
  v_disc numeric := COALESCE(p_discount_pct, 0);
  v_unit_face bigint;
  v_face bigint;
  v_gross bigint;
  v_total bigint;
  v_comm bigint;  -- organizer platform deduction
BEGIN
  IF p_unit_price IS NULL OR p_unit_price < 0 OR p_unit_price > 100000000 THEN
    RAISE EXCEPTION 'Invalid ticket price';
  END IF;
  IF v_qty < 1 OR v_qty > 100 THEN
    RAISE EXCEPTION 'Invalid quantity';
  END IF;
  IF v_disc < 0 OR v_disc > 100 THEN
    RAISE EXCEPTION 'Invalid discount';
  END IF;
  v_unit_face := round(p_unit_price * 100)::bigint;
  v_face      := v_unit_face * v_qty;
  v_gross     := public.ticket_fee_buyer_charge_kobo(p_unit_price * v_qty, v_qty, 0, v_model);
  v_total     := public.ticket_fee_buyer_charge_kobo(p_unit_price * v_qty, v_qty, v_disc, v_model);
  v_comm      := public.ticket_fee_organizer_deduction_total_kobo(p_unit_price * v_qty, v_qty, v_model);
  RETURN jsonb_build_object(
    'fee_model',                 v_model,
    'quantity',                  v_qty,
    'unit_face_kobo',            v_unit_face,
    'face_kobo',                 v_face,
    'service_fee_kobo',          v_gross - v_face,
    'discount_kobo',             v_gross - v_total,
    'total_kobo',                v_total,
    'organizer_deduction_kobo',  v_comm,
    'organizer_net_kobo',        v_face - v_comm,
    -- VENTS platform fees = attendee service fee + organizer deduction. A
    -- promo discount is funded by VENTS (the organizer's net never changes),
    -- so VENTS' net cash is the fees minus the discount it funds.
    'vents_platform_fees_kobo',  (v_gross - v_face) + v_comm,
    'vents_funded_discount_kobo', v_gross - v_total,
    'vents_revenue_kobo',        v_total - (v_face - v_comm),
    -- Rates in basis points, measured on a NGN 10,000 ticket by the same helpers.
    'service_fee_bps',           (public.ticket_fee_buyer_charge_kobo(10000, 1, 0, v_model) - 1000000) / 100,
    'organizer_deduction_bps',   public.ticket_fee_organizer_deduction_kobo(1000000, v_model) / 100);
END;
$function$;
REVOKE ALL ON FUNCTION public.ticket_fee_quote(numeric, integer, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ticket_fee_quote(numeric, integer, numeric) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.ticket_fee_buyer_charge_kobo(numeric, integer, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_fee_organizer_deduction_total_kobo(numeric, integer, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Patch the money functions 0203 patched (exact text, exactly once each)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.vents_0208_patch(p_fn text, p_pairs text[])
 RETURNS void
 LANGUAGE plpgsql
AS $f$
DECLARE
  v_def text;
  v_count integer;
  i integer;
BEGIN
  v_def := pg_get_functiondef(to_regprocedure(p_fn));
  IF v_def IS NULL THEN
    RAISE EXCEPTION '0208: % is missing', p_fn;
  END IF;
  IF position('[0208]' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;
  IF position('[0203]' IN v_def) = 0 THEN
    RAISE EXCEPTION '0208: % is not the 0203 version; apply 0203 first', p_fn;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) BY 2 LOOP
    v_count := (length(v_def) - length(replace(v_def, p_pairs[i], ''))) / length(p_pairs[i]);
    IF v_count <> 1 THEN
      RAISE EXCEPTION '0208: % contains % occurrence(s) of an expected 0203 text, not 1: %', p_fn, v_count, p_pairs[i];
    END IF;
    v_def := replace(v_def, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  EXECUTE replace(v_def, E'AS $function$\n', E'AS $function$\n-- [0208] patched by 0208_ticket_fee_1_5_3_5.sql\n');
END;
$f$;

SELECT pg_temp.vents_0208_patch('public.create_pending_purchase(uuid,text,jsonb,text,text)', ARRAY[
  $x$round(v_unit_price * v_count * (public.ticket_fee_buyer_multiplier('v2_4_5') - v_discount_pct / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_buyer_charge_kobo(v_unit_price * v_count, v_count, v_discount_pct, 'v3_15_35')$x$,
  $x$AND fee_model = 'v2_4_5'$x$, $x$AND fee_model = 'v3_15_35'$x$,
  $x$ELSE NULL END, 'v2_4_5');$x$, $x$ELSE NULL END, 'v3_15_35');$x$
]);

SELECT pg_temp.vents_0208_patch('public.confirm_ticket_payment(text,bigint)', ARRAY[
  $x$round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model)$x$,
  $x$public.ticket_fee_organizer_deduction_kobo(v_face_kobo, v_fee_model)$x$,
  $x$public.ticket_fee_organizer_deduction_total_kobo(v_total_amount, v_ticket_count, v_fee_model)$x$
]);

SELECT pg_temp.vents_0208_patch('public.confirm_ticket_payment_via_wallet(text)', ARRAY[
  $x$round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model)$x$,
  $x$public.ticket_fee_organizer_deduction_kobo(v_face_kobo, v_fee_model)$x$,
  $x$public.ticket_fee_organizer_deduction_total_kobo(v_total_amount, v_ticket_count, v_fee_model)$x$
]);

SELECT pg_temp.vents_0208_patch('public.refund_ticket(uuid,text)', ARRAY[
  $x$round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_buyer_charge_kobo(v_ticket.amount, 1, COALESCE(v_ticket.discount_percentage, 0), v_ticket.fee_model)$x$
]);

SELECT pg_temp.vents_0208_patch('public.finalize_ticket_refund(text)', ARRAY[
  $x$round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_buyer_charge_kobo(v_ticket.amount, 1, COALESCE(v_ticket.discount_percentage, 0), v_ticket.fee_model)$x$
]);

SELECT pg_temp.vents_0208_patch('public.get_event_analytics(uuid)', ARRAY[
  $x$round(amount * (public.ticket_fee_buyer_multiplier(fee_model) - COALESCE(discount_percentage, 0) / 100) * 100)$x$,
  $x$public.ticket_fee_buyer_charge_kobo(amount, 1, COALESCE(discount_percentage, 0), fee_model)$x$
]);

-- No public function may still know the unapproved 4% + 5% model.
DO $post$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosrc LIKE '%''v2_4_5''%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '0208: the 4%% + 5%% model (v2_4_5) is still referenced in: %', v_bad;
  END IF;
END
$post$;
