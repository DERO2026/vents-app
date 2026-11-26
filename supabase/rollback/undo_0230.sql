-- Undo 0230 (checkout price snapshot, finding N1). Gated: run with
--   SET vents.rollback_confirm = 'undo-0230';
-- Reverses each in-place patch exactly (every [0230] replacement back to the
-- original text; refuses if a function no longer carries it), then drops the
-- immutability trigger, the stale-quote helper and the completeness check.
-- The snapshot COLUMNS and their values are kept (no data is deleted; the
-- pre-0230 code ignores them, and re-applying 0230 reuses them).
-- WARNING: after undo, a price change during an open checkout again changes
-- what the buyer's ticket costs after they paid (finding N1). Undo 0230
-- BEFORE undoing 0229 (undo_0229 refuses while 0230 is applied).
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0230' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0230'' first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.vents_undo_0230(p_sig text, p_pairs text[][])
 RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text := pg_get_functiondef(p_sig::regprocedure);
  i int;
BEGIN
  FOR i IN 1 .. array_length(p_pairs, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_pairs[i][1], ''))) / length(p_pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'undo_0230: % does not carry 0230 patch % exactly once; refusing', p_sig, i;
    END IF;
    v_def := replace(v_def, p_pairs[i][1], p_pairs[i][2]);
  END LOOP;
  EXECUTE v_def;
END;
$h$;

SELECT pg_temp.vents_undo_0230('public.create_pending_purchase(uuid,text,jsonb,text,text)', ARRAY[
  ARRAY[$a$     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END, 'v3_15_35',
     -- [0230] immutable quote snapshot (same 0208 helpers as amount_kobo)
     v_unit_price, v_discount_pct, v_count,
     v_count * round(v_unit_price * 100)::bigint,
     public.ticket_fee_buyer_charge_kobo(v_unit_price * v_count, v_count, 0, 'v3_15_35') - v_count * round(v_unit_price * 100)::bigint,
     public.ticket_fee_buyer_charge_kobo(v_unit_price * v_count, v_count, 0, 'v3_15_35') - v_amount_kobo,
     public.ticket_fee_organizer_deduction_total_kobo(v_unit_price * v_count, v_count, 'v3_15_35'),
     'NGN',
     CASE WHEN v_ticket_obj IS NOT NULL THEN COALESCE(NULLIF(btrim(v_ticket_obj->>'key'), ''), v_ticket_obj->>'name') END,
     now());$a$, $a$     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END, 'v3_15_35');$a$],
  ARRAY[$a$    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at, fee_model,
     quote_unit_price, quote_discount_pct, quote_quantity, quote_face_kobo, quote_service_fee_kobo, quote_discount_kobo,
     quote_organizer_deduction_kobo, quote_currency, quote_tier_key, quoted_at)$a$, $a$    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at, fee_model)$a$],
  ARRAY[$a$     AND fee_model = 'v3_15_35'
     AND created_at > now() - interval '30 minutes'
     -- [0230] reuse only an order whose agreed quote equals today's quote
     AND amount_kobo = v_amount_kobo
     AND quote_unit_price = v_unit_price
     AND quote_discount_pct = v_discount_pct$a$, $a$     AND fee_model = 'v3_15_35'
     AND created_at > now() - interval '30 minutes'$a$]
]);

SELECT pg_temp.vents_undo_0230('public.finalize_pending_purchase(text)', ARRAY[
  ARRAY[$a$    IF v_row.promo_code IS NOT NULL THEN
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
    END IF;$a$, $a$    IF v_row.promo_code IS NOT NULL THEN
      SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
      IF FOUND THEN
        v_discount_pct := v_promo.discount_percentage;
      END IF;
    END IF;$a$]
]);

SELECT pg_temp.vents_undo_0230('public.confirm_ticket_payment(text,bigint)', ARRAY[
  ARRAY[$a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);
  -- [0230] The order's agreed total is authoritative. If the tickets ever
  -- disagree with it, confirm nothing (recorded as a payment exception).
  IF EXISTS (SELECT 1 FROM public.pending_purchases pp
              WHERE pp.payment_ref = p_reference AND pp.quote_unit_price IS NOT NULL
                AND pp.amount_kobo IS DISTINCT FROM v_expected_kobo) THEN
    RETURN 'amount_mismatch:' || (SELECT pp.amount_kobo FROM public.pending_purchases pp WHERE pp.payment_ref = p_reference)::text || ':' || p_amount_kobo::text;
  END IF;
  IF p_amount_kobo < v_expected_kobo THEN$a$, $a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);
  IF p_amount_kobo < v_expected_kobo THEN$a$]
]);

SELECT pg_temp.vents_undo_0230('public.confirm_ticket_payment_via_wallet(text)', ARRAY[
  ARRAY[$a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);
  -- [0230] Debit exactly the order's agreed total; refuse if the tickets disagree.
  IF EXISTS (SELECT 1 FROM public.pending_purchases pp
              WHERE pp.payment_ref = p_payment_ref AND pp.quote_unit_price IS NOT NULL
                AND pp.amount_kobo IS DISTINCT FROM v_expected_kobo) THEN
    RAISE EXCEPTION 'This order''s total does not match its tickets; nothing was charged';
  END IF;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)$a$, $a$  v_expected_kobo := public.ticket_fee_buyer_charge_kobo(v_total_amount, v_ticket_count, COALESCE(v_discount_pct, 0), v_fee_model);

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)$a$],
  ARRAY[$a$  -- [0230] Never start a wallet charge against a quote that is no longer current.
  v_quote_problem := public.ticket_order_quote_problem(p_payment_ref);
  IF v_quote_problem IS NOT NULL THEN
    RAISE EXCEPTION '%', v_quote_problem;
  END IF;

  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);$a$, $a$  BEGIN
    PERFORM public.finalize_pending_purchase(p_payment_ref);$a$],
  ARRAY[$a$  v_deduction_kobo  bigint;
  v_quote_problem   text;  -- [0230]
BEGIN$a$, $a$  v_deduction_kobo  bigint;
BEGIN$a$]
]);

SELECT pg_temp.vents_undo_0230('public.initiate_ticket_payment_attempt(text)', ARRAY[
  ARRAY[$a$  -- [0230] Never start a card charge against a quote that is no longer
  -- current. The order itself is left unchanged.
  v_ref := public.ticket_order_quote_problem(v_row.payment_ref);
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION '%', v_ref;
  END IF;

  v_ref := 'PSK-' || replace(gen_random_uuid()::text, '-', '');$a$, $a$  v_ref := 'PSK-' || replace(gen_random_uuid()::text, '-', '');$a$]
]);

DROP TRIGGER IF EXISTS trg_pending_purchases_quote_immutable ON public.pending_purchases;
DROP FUNCTION IF EXISTS public.pending_purchases_quote_immutable();
DROP FUNCTION IF EXISTS public.ticket_order_quote_problem(text);
ALTER TABLE public.pending_purchases DROP CONSTRAINT IF EXISTS pending_purchases_quote_complete;

COMMIT;
