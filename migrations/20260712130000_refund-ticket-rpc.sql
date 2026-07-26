-- Refund flow for ticket purchases. tickets.payment_status has allowed
-- 'refunded' since 20260614071000, but nothing in this codebase could ever
-- set it: no RPC, no endpoint, no UI action existed. An organizer/admin had
-- no way to actually refund a buyer short of hand-editing the database.
--
-- Two-phase, webhook-finalized, mirroring the existing organizer payout flow
-- (request_organizer_payout -> 'processing' -> complete/fail_organizer_payout
-- via transfer.success/transfer.failed webhooks) rather than one synchronous
-- RPC, because a Postgres function cannot call out to Paystack's HTTP API
-- itself, and Paystack's refund-creation response only means "accepted for
-- processing" -- the authoritative "money actually moved" signal is the
-- later refund.processed / refund.failed webhook (api/webhook/paystack.ts).
--
-- Phase 1 -- refund_ticket(p_ticket_id, p_reason): callable by the event's
--   organizer, an admin/sub-admin, or root. Locks the ticket, requires it be
--   currently 'paid', and flips it to 'refund_pending' with status
--   'cancelled' immediately -- once a refund is underway the ticket must
--   stop granting entry even while Paystack is still processing (card
--   refunds can take several business days). Free tickets (amount = 0) have
--   no money to move and are finalized immediately, no Paystack call needed.
--   Returns the payment_ref/amount the API layer needs to call Paystack's
--   refund API. Idempotent: retrying against an already-pending or
--   already-refunded ticket returns the existing state instead of erroring.
-- Phase 2 -- attach_ticket_refund_id: records the Paystack refund id
--   returned by the create-refund call, so the later webhook can find this
--   ticket again (mirrors transfer_code tracking for payouts).
-- Phase 3 -- finalize_ticket_refund / fail_ticket_refund: called from the
--   refund.processed / refund.failed webhook handlers (SECURITY DEFINER,
--   granted to anon like confirm_ticket_payment, since the webhook has no
--   user session -- safe because refund_id is an opaque, Paystack-issued
--   identifier the caller can't guess or enumerate, and each function only
--   ever touches the one ticket matching it). Finalize debits the
--   organizer's wallet for exactly what credit_organizer_wallet originally
--   credited for this ticket, clamped at the wallet's current balance so
--   this can never drive balance_kobo negative (the organizer may have
--   already withdrawn some or all of it) -- any shortfall is recorded in
--   admin_logs rather than silently absorbed. Fail reverts the ticket back
--   to 'paid'/'active' so it can be retried.
--
-- VC (Vents Cents) earned on the original purchase and promo_codes.current_uses
-- are intentionally NOT clawed back here -- both are shared across an entire
-- multi-attendee payment group (one payment_ref can cover several tickets),
-- so a single-ticket refund can't unambiguously reverse either without
-- risking clawing back VC/uses that other, non-refunded tickets in the same
-- group still legitimately earned/consumed. Out of scope for this pass.

ALTER TABLE public.tickets DROP CONSTRAINT tickets_payment_status_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_payment_status_check
  CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded', 'refund_pending'));

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS refund_id text,
  ADD COLUMN IF NOT EXISTS refund_reason text,
  ADD COLUMN IF NOT EXISTS refund_initiated_by uuid REFERENCES public.users(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_refund_id ON public.tickets(refund_id) WHERE refund_id IS NOT NULL;

ALTER TABLE public.organizer_transactions DROP CONSTRAINT organizer_transactions_type_check;
ALTER TABLE public.organizer_transactions ADD CONSTRAINT organizer_transactions_type_check
  CHECK (type IN ('credit', 'debit', 'payout', 'cancelled_payout_refund', 'refund'));

-- ── Phase 1: initiate ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket      record;
  v_refund_kobo bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A refund reason is required';
  END IF;

  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,
         t.ticket_type, t.user_id, t.checked_in, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'Only the event organizer or an admin can refund this ticket';
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'ticket_id', v_ticket.id);
  END IF;

  IF v_ticket.payment_status = 'refund_pending' THEN
    RETURN jsonb_build_object(
      'status', 'refund_pending', 'ticket_id', v_ticket.id, 'payment_ref', v_ticket.payment_ref
    );
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only paid tickets can be refunded (current status: %)', v_ticket.payment_status;
  END IF;

  -- Buyer's paid share for this ticket, service fee included -- the
  -- per-ticket version of the group formula confirm_ticket_payment sums
  -- (CheckoutScreen.tsx: total = subtotal * (1.05 - discount%/100)). Summed
  -- across every ticket sharing a payment_ref this equals the group total
  -- that was actually charged, so refunding one ticket at a time out of a
  -- multi-attendee purchase never over- or under-refunds what Paystack
  -- actually collected.
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  -- Free ticket: nothing was ever charged or credited to the organizer, so
  -- finalize immediately -- no Paystack call needed, nothing to reverse.
  IF v_ticket.amount <= 0 OR v_refund_kobo <= 0 THEN
    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_ticket.user_id, 'booking', 'Ticket refunded',
      'Your ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been refunded. Reason: ' || p_reason,
      false, '💸'
    );

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (
      auth.uid(), 'refund_ticket', v_ticket.user_id,
      jsonb_build_object('ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', 0),
      public.actor_role()
    );

    RETURN jsonb_build_object('status', 'refunded', 'ticket_id', v_ticket.id, 'amount_kobo', 0);
  END IF;

  UPDATE public.tickets
     SET payment_status = 'refund_pending', status = 'cancelled',
         refund_reason = p_reason, refund_initiated_by = auth.uid()
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'refund_ticket_initiated', v_ticket.user_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', v_refund_kobo,
      'checked_in', v_ticket.checked_in
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'status', 'refund_pending',
    'ticket_id', v_ticket.id,
    'payment_ref', v_ticket.payment_ref,
    'amount_kobo', v_refund_kobo,
    'user_id', v_ticket.user_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refund_ticket(uuid, text) TO authenticated;

-- ── Phase 2: record the Paystack refund id ─────────────────────────────
-- Re-checks the same authorization as phase 1 (defense in depth -- this
-- still mutates ticket state) rather than trusting that only phase 1's
-- caller could reach here.
CREATE OR REPLACE FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_status       text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT e.organizer_id, t.payment_status INTO v_organizer_id, v_status
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Ticket is not awaiting a refund (status: %)', v_status;
  END IF;

  UPDATE public.tickets SET refund_id = p_refund_id WHERE id = p_ticket_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.attach_ticket_refund_id(uuid, text) TO authenticated;

-- ── Phase 3a: webhook-driven completion ────────────────────────────────
-- Returns buyer contact details (not just a status string) so the webhook
-- handler can send the refund confirmation email itself, the same way
-- complete_organizer_payout/fail_organizer_payout hand back organizer_email
-- for the payout decision email.
CREATE OR REPLACE FUNCTION public.finalize_ticket_refund(p_refund_id text)
 RETURNS TABLE (
   status text, buyer_email text, buyer_name text, event_title text,
   ticket_type text, refunded_amount_kobo bigint, reason text
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket       record;
  v_owed_kobo    bigint;
  v_wallet_bal   bigint;
  v_actual_debit bigint;
  v_refund_kobo  bigint;
BEGIN
  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.ticket_type, t.payment_status,
         t.refund_initiated_by, t.refund_reason, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  -- Buyer-facing amount for the confirmation email -- the fee-inclusive
  -- figure Paystack actually refunded, same formula phase 1 used to decide
  -- how much to send Paystack (not v_ticket.amount, which is the
  -- organizer's fee-excluded share and would understate what the buyer
  -- gets back).
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  UPDATE public.tickets SET payment_status = 'refunded' WHERE id = v_ticket.id;

  -- Reverse exactly what credit_organizer_wallet originally credited for
  -- this ticket (organizer keeps the full ticket price, no fee skim -- see
  -- organizer-full-ticket-payout.sql), clamped at the wallet's current
  -- balance under a row lock so a concurrent credit/debit on the same
  -- wallet can't race this. Any shortfall (organizer already withdrew some
  -- or all of it) is written to admin_logs rather than silently dropped.
  IF v_ticket.amount > 0 AND v_ticket.organizer_id IS NOT NULL THEN
    v_owed_kobo := floor(v_ticket.amount * 100)::bigint;

    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_ticket.organizer_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_owed_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_ticket.organizer_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
      VALUES (
        v_ticket.organizer_id, 'refund', v_actual_debit,
        'Refund: ' || v_ticket.ticket_type ||
          CASE WHEN v_actual_debit < v_owed_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
               ELSE '' END,
        v_ticket.id
      );
    END IF;

    IF v_actual_debit < v_owed_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_ticket.refund_initiated_by, 'refund_wallet_shortfall', v_ticket.organizer_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_owed_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_ticket.user_id, 'booking', 'Ticket refunded',
    'Your refund for the ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been processed.',
    false, '💸'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_finalized', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id),
    'webhook'
  );

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type,
         v_refund_kobo, v_ticket.refund_reason
    FROM public.users u WHERE u.id = v_ticket.user_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finalize_ticket_refund(text) TO anon, authenticated;

-- ── Phase 3b: webhook-driven failure ───────────────────────────────────
-- Returns the initiating organizer/admin's contact details (not the
-- buyer's) -- the ticket reverts to fully valid/paid, so the buyer has
-- nothing to be told; the person who needs to know their refund attempt
-- failed and may need to retry or refund manually is whoever ran phase 1.
CREATE OR REPLACE FUNCTION public.fail_ticket_refund(p_refund_id text, p_reason text)
 RETURNS TABLE (
   status text, actor_email text, actor_name text, event_title text, ticket_type text
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  SELECT t.id, t.user_id, t.ticket_type, t.payment_status, t.refund_initiated_by, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_failed', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id, 'reason', p_reason),
    'webhook'
  );

  RETURN QUERY
  SELECT 'reverted'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type
    FROM public.users u WHERE u.id = v_ticket.refund_initiated_by;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fail_ticket_refund(text, text) TO anon, authenticated;

-- ── Manual escape hatch ─────────────────────────────────────────────────
-- A refund stuck in 'refund_pending' where the Paystack refund-creation
-- call itself never even succeeded (network error, 4xx from Paystack) has
-- no refund_id, so fail_ticket_refund's webhook-driven path can never reach
-- it. Mirrors admin_cancel_processing_payout's role for stuck 'processing'
-- withdrawal requests -- an admin-only manual release valve.
CREATE OR REPLACE FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF NOT public.is_admin() AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT id, user_id, payment_status INTO v_ticket
    FROM public.tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Only tickets awaiting refund can be reverted (current status: %)', v_ticket.payment_status;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_revert_stuck_refund', v_ticket.user_id,
    jsonb_build_object('ticket_id', p_ticket_id, 'reason', p_reason),
    public.actor_role()
  );

  RETURN 'reverted';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_revert_stuck_refund(uuid, text) TO authenticated;
