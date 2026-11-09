-- Undo 0208 only (supabase/migrations/0208_ticket_fee_1_5_3_5.sql): back to
-- 0203's 4% + 5% model. NOT a migration; never applied by tooling. Runbook
-- row R1d, in one transaction, BEFORE R1c (undo_0207):
--   SET vents.rollback_confirm = 'undo-0208';
--   \i supabase/rollback/undo_0208.sql
-- Refused once any purchase or ticket was made on the 1.5% + 3.5% model
-- (their refunds and analytics need 0208's arithmetic). Changes no ticket,
-- wallet or ledger row.
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0208' THEN
    RAISE EXCEPTION 'undo_0208 refused: set vents.rollback_confirm = ''undo-0208'' to confirm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tickets WHERE fee_model = 'v3_15_35')
     OR EXISTS (SELECT 1 FROM public.pending_purchases WHERE fee_model = 'v3_15_35') THEN
    RAISE EXCEPTION 'undo_0208 refused: purchases exist on the 1.5%% + 3.5%% model';
  END IF;
END
$undo$;

CREATE OR REPLACE FUNCTION pg_temp.vents_undo_0208(p_fn text, p_pairs text[])
 RETURNS void
 LANGUAGE plpgsql
AS $f$
DECLARE
  v_def text;
  i integer;
BEGIN
  v_def := pg_get_functiondef(to_regprocedure(p_fn));
  IF position('[0208]' IN v_def) = 0 THEN
    RETURN;  -- not patched
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) BY 2 LOOP
    IF position(p_pairs[i] IN v_def) = 0 THEN
      RAISE EXCEPTION 'undo_0208: % does not contain the 0208 text: %', p_fn, p_pairs[i];
    END IF;
    v_def := replace(v_def, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  EXECUTE replace(v_def, E'-- [0208] patched by 0208_ticket_fee_1_5_3_5.sql\n', '');
END;
$f$;

SELECT pg_temp.vents_undo_0208('public.create_pending_purchase(uuid,text,jsonb,text,text)', ARRAY[
  $x$public.ticket_fee_buyer_charge_kobo(v_unit_price * v_count, v_count, v_discount_pct, 'v3_15_35')$x$,
  $x$round(v_unit_price * v_count * (public.ticket_fee_buyer_multiplier('v2_4_5') - v_discount_pct / 100) * 100)::bigint$x$,
  $x$AND fee_model = 'v3_15_35'$x$,
  $x$AND fee_model = 'v2_4_5'$x$,
  $x$ELSE NULL END, 'v3_15_35');$x$,
  $x$ELSE NULL END, 'v2_4_5');$x$
]);
SELECT pg_temp.vents_undo_0208('public.confirm_ticket_payment(text,bigint)', ARRAY[
  $x$public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model)$x$,
  $x$round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_organizer_deduction_total_kobo(v_total_amount, v_ticket_count, v_fee_model)$x$,
  $x$public.ticket_fee_organizer_deduction_kobo(v_face_kobo, v_fee_model)$x$
]);
SELECT pg_temp.vents_undo_0208('public.confirm_ticket_payment_via_wallet(text)', ARRAY[
  $x$public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model)$x$,
  $x$round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint$x$,
  $x$public.ticket_fee_organizer_deduction_total_kobo(v_total_amount, v_ticket_count, v_fee_model)$x$,
  $x$public.ticket_fee_organizer_deduction_kobo(v_face_kobo, v_fee_model)$x$
]);
SELECT pg_temp.vents_undo_0208('public.refund_ticket(uuid,text)', ARRAY[
  $x$public.ticket_fee_buyer_charge_kobo(v_ticket.amount, 1, COALESCE(v_ticket.discount_percentage, 0), v_ticket.fee_model)$x$,
  $x$round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint$x$
]);
SELECT pg_temp.vents_undo_0208('public.finalize_ticket_refund(text)', ARRAY[
  $x$public.ticket_fee_buyer_charge_kobo(v_ticket.amount, 1, COALESCE(v_ticket.discount_percentage, 0), v_ticket.fee_model)$x$,
  $x$round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint$x$
]);
SELECT pg_temp.vents_undo_0208('public.get_event_analytics(uuid)', ARRAY[
  $x$public.ticket_fee_buyer_charge_kobo(amount, 1, COALESCE(discount_percentage, 0), fee_model)$x$,
  $x$round(amount * (public.ticket_fee_buyer_multiplier(fee_model) - COALESCE(discount_percentage, 0) / 100) * 100)$x$
]);

CREATE OR REPLACE FUNCTION public.ticket_fee_buyer_multiplier(p_fee_model text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  RETURN CASE p_fee_model WHEN 'v2_4_5' THEN 1.04 WHEN 'legacy_5' THEN 1.05
         ELSE NULL END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ticket_fee_organizer_deduction_kobo(p_face_kobo bigint, p_fee_model text)
 RETURNS bigint
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_fee_model = 'v2_4_5' THEN
    RETURN round(GREATEST(COALESCE(p_face_kobo, 0), 0) * 5 / 100.0)::bigint;
  ELSIF p_fee_model = 'legacy_5' THEN
    RETURN 0;
  END IF;
  RAISE EXCEPTION 'Unknown ticket fee model: %', p_fee_model;
END;
$function$;

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
        'v2_4_5');
    ELSE
      NEW.fee_model := 'v2_4_5';
    END IF;
  ELSIF NEW.fee_model IS DISTINCT FROM OLD.fee_model THEN
    RAISE EXCEPTION 'fee_model cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.earn_ticket_nominal_fee_kobo(p_amount numeric, p_fee_model text)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT GREATEST(0, ceil(COALESCE(p_amount, 0) * CASE WHEN p_fee_model = 'v2_4_5' THEN 9 ELSE 5 END))::bigint;
$function$;

ALTER TABLE public.tickets ALTER COLUMN fee_model SET DEFAULT 'v2_4_5';
ALTER TABLE public.pending_purchases ALTER COLUMN fee_model SET DEFAULT 'v2_4_5';
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_fee_model_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_fee_model_check CHECK (fee_model IN ('legacy_5', 'v2_4_5'));
ALTER TABLE public.pending_purchases DROP CONSTRAINT IF EXISTS pending_purchases_fee_model_check;
ALTER TABLE public.pending_purchases ADD CONSTRAINT pending_purchases_fee_model_check CHECK (fee_model IN ('legacy_5', 'v2_4_5'));
DROP FUNCTION IF EXISTS public.ticket_fee_quote(numeric, integer, numeric);
DROP FUNCTION IF EXISTS public.ticket_fee_buyer_charge_kobo(numeric, integer, numeric, text);
DROP FUNCTION IF EXISTS public.ticket_fee_organizer_deduction_total_kobo(numeric, integer, text);
