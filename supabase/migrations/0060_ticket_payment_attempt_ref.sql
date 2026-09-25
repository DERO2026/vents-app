-- Fixes "Duplicate Transaction Reference" from Paystack on any retry (self-
-- pay or Someone Else Pays): CheckoutScreen.tsx and PaymentRequestScreen.tsx
-- were both passing pending_purchases.payment_ref -- a STABLE identifier --
-- directly as Paystack's own transaction reference. Paystack initializes a
-- real transaction the moment the popup opens, so reopening it with the
-- same reference (closed/abandoned popup, reload, or simply revisiting a
-- persisted payment request) is rejected as a duplicate.
--
-- This migration does NOT change payment_ref's meaning or value anywhere --
-- it stays the permanent, stable request/order identity used by every
-- existing RLS-scoped RPC, deep link, and finalize/confirm/ticket lookup.
--
-- Design note (superseding an earlier draft of this same migration that was
-- never applied): an overwrite-a-single-column approach (mirroring
-- ticket_transfers.fee_payment_ref, 0043_ticket_transfer_fee.sql) has a real
-- payment-safety hole -- if attempt A (say, a bank_transfer/ussd/mobile_money
-- channel, which this app already supports and which routinely completes
-- asynchronously, well after the popup closes) is still in flight when a
-- retry mints attempt B and overwrites the "current" reference, A's later
-- webhook arrives referencing a value that no longer resolves to anything.
-- The buyer is charged by Paystack and no ticket is ever created, with no
-- trace back to the order. This is NOT hypothetical for this app's channel
-- list, and the transfer-fee implementation has the same latent hole (out
-- of scope to fix here, not something this migration touches).
--
-- Fixed instead with an additive attempt-mapping table: every payment
-- attempt gets its own permanent row, so EVERY historical attempt reference
-- for an order stays resolvable back to it for as long as the order exists
-- -- never overwritten, never orphaned. Duplicate ticket creation is still
-- fully prevented by finalize_pending_purchase's existing row lock +
-- status='completed' idempotency check, keyed by the stable payment_ref via
-- pending_purchase_id -- completely unaffected by which attempt reference
-- happens to trigger it.

-- ── 1. ticket_payment_attempts: one permanent row per Paystack attempt,
-- never updated or deleted. Fully locked down at the table level (RLS
-- enabled, zero grants to any client-facing role) -- touched only by the
-- SECURITY DEFINER functions below, exactly like pending_purchases itself.
CREATE TABLE IF NOT EXISTS public.ticket_payment_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pending_purchase_id uuid NOT NULL REFERENCES public.pending_purchases(id),
  paystack_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_payment_attempts_paystack_ref_idx
  ON public.ticket_payment_attempts (paystack_ref);
CREATE INDEX IF NOT EXISTS ticket_payment_attempts_pending_purchase_id_idx
  ON public.ticket_payment_attempts (pending_purchase_id);

ALTER TABLE public.ticket_payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_payment_attempts FROM PUBLIC, anon, authenticated, project_admin;

-- ── 2. initiate_ticket_payment_attempt: mints a fresh, disposable Paystack
-- reference for this specific attempt and records it as a NEW row -- safe
-- to call again after an abandoned/failed popup, a page reload, or simply
-- revisiting a persisted Someone-Else-Pays request. Every past attempt for
-- this order remains independently resolvable afterwards; nothing is ever
-- overwritten. Authorizes EITHER the recipient (user_id) or the resolved
-- payer (payer_id) -- the one difference from initiate_transfer_fee_
-- payment's recipient-only check, since this same request may legitimately
-- be paid by either party depending on payMode. Returns the row's own
-- amount_kobo alongside the reference so the caller never has to trust a
-- client-held number that could be stale by the time payment actually
-- starts.
CREATE OR REPLACE FUNCTION public.initiate_ticket_payment_attempt(p_payment_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.pending_purchases%ROWTYPE;
  v_ref text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM public.check_rate_limit('ticket_payment_attempt:' || v_uid::text, 20, 3600);

  SELECT * INTO v_row FROM public.pending_purchases WHERE payment_ref = p_payment_ref FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Payment request not found'; END IF;

  IF v_uid IS DISTINCT FROM v_row.user_id AND v_uid IS DISTINCT FROM v_row.payer_id THEN
    RAISE EXCEPTION 'Not authorized to pay this request';
  END IF;

  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This payment request is no longer pending (status: %)', v_row.status;
  END IF;

  -- expires_at is NULL for every normal self-pay purchase (no payer_id was
  -- ever resolved) and never expires; only an actual "someone else pays"
  -- request has a real deadline to check here -- same convention
  -- finalize_pending_purchase already uses (0058).
  IF v_row.expires_at IS NOT NULL AND v_row.expires_at < now() THEN
    UPDATE public.pending_purchases SET status = 'expired' WHERE id = v_row.id;
    RAISE EXCEPTION 'This payment request has expired';
  END IF;

  v_ref := 'PSK-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.ticket_payment_attempts (pending_purchase_id, paystack_ref)
  VALUES (v_row.id, v_ref);

  RETURN jsonb_build_object('reference', v_ref, 'amount_kobo', v_row.amount_kobo);
END;
$function$
;

REVOKE ALL ON FUNCTION public.initiate_ticket_payment_attempt(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.initiate_ticket_payment_attempt(text) TO authenticated, project_admin;

-- ── 3. get_pending_purchase_owner: now resolves EITHER any historical
-- attempt reference (ticket_payment_attempts, every payment initiated via
-- initiate_ticket_payment_attempt, i.e. everything going forward) OR a bare
-- payment_ref (any pending_purchases row whose live Paystack reference
-- literally equalled its own payment_ref from BEFORE this migration
-- shipped -- the exact old/broken behavior this whole change replaces).
-- Falling back to payment_ref is safe, not just a stopgap: payment_ref is
-- globally unique (gen_random_uuid()-derived, same as every attempt's
-- paystack_ref), so this can never resolve to the WRONG row -- at most it
-- finds the one legacy row that literally used that string as its Paystack
-- reference under the old client code, exactly the row Paystack's own
-- transaction record already names. No backfill of existing rows is needed
-- or attempted.
-- Also now returns payment_ref itself, since the caller (the webhook) can
-- no longer assume the reference IT received IS the payment_ref to hand to
-- finalize_pending_purchase/confirm_ticket_payment/get_tickets_for_payment_ref
-- -- those still take the stable payment_ref, unchanged, so this is the one
-- place that resolves attempt-reference -> stable identity before that.
-- Return type changes again (adding a column) -- explicit DROP first, same
-- reasoning as every prior return-type change in this project (0058).
DROP FUNCTION IF EXISTS public.get_pending_purchase_owner(text);

CREATE OR REPLACE FUNCTION public.get_pending_purchase_owner(p_reference text)
 RETURNS TABLE(payment_ref text, owner_id uuid, payer_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT pp.payment_ref, pp.user_id, pp.payer_id
  FROM public.pending_purchases pp
  JOIN public.ticket_payment_attempts tpa ON tpa.pending_purchase_id = pp.id
  WHERE tpa.paystack_ref = p_reference
  UNION ALL
  SELECT payment_ref, user_id, payer_id FROM public.pending_purchases WHERE payment_ref = p_reference
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_purchase_owner(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_pending_purchase_owner(text) TO project_admin;
