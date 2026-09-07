-- Fixes the charged-but-not-transferred race identified in the Ticket
-- Transfer audit: recipient starts the Paystack fee payment -> sender
-- cancels (or the 48h window expires, or the ticket becomes ineligible in
-- that window) -> Paystack payment succeeds -> confirm_transfer_fee_payment
-- correctly refuses to move ownership -- but until now the recipient's
-- money was left charged with nothing but a generic "contact support"
-- message and no queryable record of the obligation.
--
-- Does NOT touch transfer authorization, RLS, row locking, expiry, or fee
-- validation -- confirm_transfer_fee_payment's existing eligibility checks
-- and ownership-swap logic are unchanged; this only adds what happens
-- AFTER it decides (as it always has) that the swap cannot proceed.
--
-- Refund mechanism: reuses the EXACT existing Paystack refund integration
-- (api/wallet/refund-ticket.ts's POST https://api.paystack.co/refund with
-- PAYSTACK_SECRET_KEY, already used for organizer/admin-initiated ticket
-- refunds) and the EXACT existing async-confirmation pattern (refund.
-- processed/refund.failed webhook events, finalize_ticket_refund/
-- fail_ticket_refund) -- no new Paystack API call invented, no new secret.
--
-- Idempotency: ticket_transfers.fee_refund_needed_at is claimed exactly
-- once, under the SAME row lock confirm_transfer_fee_payment already holds
-- for the whole function call -- only the caller that transitions it from
-- NULL to now() may initiate the actual Paystack refund call; every other
-- concurrent/retried caller (webhook + client-verify racing, or a Paystack
-- webhook retry) sees it already set and skips straight to the (idempotent)
-- durable-record check. attach_transfer_fee_refund_id additionally never
-- overwrites an already-attached fee_refund_id, as a second, cheap
-- safety net against ever creating two Paystack refunds for one payment.

ALTER TABLE public.ticket_transfers
  ADD COLUMN IF NOT EXISTS fee_refund_needed_at timestamptz,
  ADD COLUMN IF NOT EXISTS fee_refund_id text,
  ADD COLUMN IF NOT EXISTS fee_refund_status text,
  ADD COLUMN IF NOT EXISTS fee_refund_completed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_transfers_fee_refund_id_idx
  ON public.ticket_transfers (fee_refund_id) WHERE (fee_refund_id IS NOT NULL);

-- ---------------------------------------------------------------------
-- confirm_transfer_fee_payment: unchanged eligibility/ownership-swap
-- logic. Each of the three branches where a genuinely-successful payment
-- (Paystack already confirmed p_amount_kobo was charged, by the callers'
-- own contract) can no longer be completed now durably records the
-- obligation exactly once, and tells the caller (via a ':refund_claimed'
-- suffix on the returned status, checked by api/webhook/paystack.ts) when
-- it is the one that should actually call Paystack's refund API.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_transfer_fee_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_transfer  record;
  v_ticket    record;
  v_full_name text;
  v_email     text;
  v_phone     text;
  v_rows      int;
  v_claimed   boolean;
BEGIN
  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE fee_payment_ref = p_reference FOR UPDATE;
  IF v_transfer.id IS NULL THEN RETURN 'not_found'; END IF;

  -- Idempotent: a retried webhook/verify call for an already-confirmed
  -- transfer is a no-op, not an error -- same convention as
  -- confirm_ticket_payment's own 'already_paid' branch.
  IF v_transfer.fee_paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;

  IF v_transfer.status <> 'pending' THEN
    v_claimed := false;
    IF v_transfer.fee_refund_needed_at IS NULL THEN
      UPDATE public.ticket_transfers
         SET fee_refund_needed_at = now(), fee_refund_status = 'needed'
       WHERE id = v_transfer.id;
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        NULL, 'transfer_fee_refund_needed', v_transfer.to_user_id,
        jsonb_build_object(
          'transfer_id', v_transfer.id, 'ticket_id', v_transfer.ticket_id,
          'payer_id', v_transfer.to_user_id, 'sender_id', v_transfer.from_user_id,
          'paystack_reference', p_reference, 'amount_kobo', p_amount_kobo,
          'reason', 'transfer_' || v_transfer.status
        ),
        'webhook'
      );
      v_claimed := true;
    END IF;
    RETURN 'transfer_not_pending:' || v_transfer.status || (CASE WHEN v_claimed THEN ':refund_claimed' ELSE '' END);
  END IF;

  IF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = v_transfer.id;
    v_claimed := false;
    IF v_transfer.fee_refund_needed_at IS NULL THEN
      UPDATE public.ticket_transfers
         SET fee_refund_needed_at = now(), fee_refund_status = 'needed'
       WHERE id = v_transfer.id;
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        NULL, 'transfer_fee_refund_needed', v_transfer.to_user_id,
        jsonb_build_object(
          'transfer_id', v_transfer.id, 'ticket_id', v_transfer.ticket_id,
          'payer_id', v_transfer.to_user_id, 'sender_id', v_transfer.from_user_id,
          'paystack_reference', p_reference, 'amount_kobo', p_amount_kobo,
          'reason', 'transfer_expired'
        ),
        'webhook'
      );
      v_claimed := true;
    END IF;
    RETURN 'expired' || (CASE WHEN v_claimed THEN ':refund_claimed' ELSE '' END);
  END IF;

  IF p_amount_kobo IS DISTINCT FROM v_transfer.fee_kobo THEN
    RETURN 'amount_mismatch:' || v_transfer.fee_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  SELECT t.user_id, t.status, t.checked_in
    INTO v_ticket
    FROM public.tickets t
   WHERE t.id = v_transfer.ticket_id
   FOR UPDATE;

  IF v_ticket.user_id IS DISTINCT FROM v_transfer.from_user_id
     OR v_ticket.status <> 'active' OR v_ticket.checked_in THEN
    UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = v_transfer.id;
    v_claimed := false;
    IF v_transfer.fee_refund_needed_at IS NULL THEN
      UPDATE public.ticket_transfers
         SET fee_refund_needed_at = now(), fee_refund_status = 'needed'
       WHERE id = v_transfer.id;
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        NULL, 'transfer_fee_refund_needed', v_transfer.to_user_id,
        jsonb_build_object(
          'transfer_id', v_transfer.id, 'ticket_id', v_transfer.ticket_id,
          'payer_id', v_transfer.to_user_id, 'sender_id', v_transfer.from_user_id,
          'paystack_reference', p_reference, 'amount_kobo', p_amount_kobo,
          'reason', 'ticket_ineligible'
        ),
        'webhook'
      );
      v_claimed := true;
    END IF;
    RETURN 'ticket_ineligible' || (CASE WHEN v_claimed THEN ':refund_claimed' ELSE '' END);
  END IF;

  SELECT full_name, email, phone_number INTO v_full_name, v_email, v_phone
    FROM public.users WHERE id = v_transfer.to_user_id;

  UPDATE public.tickets
     SET user_id = v_transfer.to_user_id,
         holder_name = COALESCE(v_full_name, holder_name),
         holder_email = COALESCE(v_email, holder_email),
         holder_phone = COALESCE(v_phone, holder_phone)
   WHERE id = v_transfer.ticket_id
     AND user_id = v_transfer.from_user_id
     AND checked_in = false;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = v_transfer.id;
    v_claimed := false;
    IF v_transfer.fee_refund_needed_at IS NULL THEN
      UPDATE public.ticket_transfers
         SET fee_refund_needed_at = now(), fee_refund_status = 'needed'
       WHERE id = v_transfer.id;
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        NULL, 'transfer_fee_refund_needed', v_transfer.to_user_id,
        jsonb_build_object(
          'transfer_id', v_transfer.id, 'ticket_id', v_transfer.ticket_id,
          'payer_id', v_transfer.to_user_id, 'sender_id', v_transfer.from_user_id,
          'paystack_reference', p_reference, 'amount_kobo', p_amount_kobo,
          'reason', 'ticket_ineligible'
        ),
        'webhook'
      );
      v_claimed := true;
    END IF;
    RETURN 'ticket_ineligible' || (CASE WHEN v_claimed THEN ':refund_claimed' ELSE '' END);
  END IF;

  UPDATE public.ticket_transfers
     SET status = 'accepted', responded_at = now(), fee_paid_at = now()
   WHERE id = v_transfer.id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_transfer.from_user_id, 'event_update', 'Ticket transfer accepted',
    'Your ticket transfer was accepted.', false, '✅',
    jsonb_build_object('transferId', v_transfer.id, 'ticketId', v_transfer.ticket_id)
  );

  RETURN 'confirmed';
END;
$function$
;

-- ---------------------------------------------------------------------
-- attach_transfer_fee_refund_id: called only from api/webhook/paystack.ts
-- right after it successfully creates the Paystack refund (mirrors
-- attach_ticket_refund_id's role for the ticket-refund flow exactly).
-- Keyed by fee_payment_ref (the data the webhook actually has in hand),
-- not transfer id. Never overwrites an already-attached fee_refund_id --
-- a second safety net against a double Paystack refund alongside the
-- confirm_transfer_fee_payment claim above.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attach_transfer_fee_refund_id(p_reference text, p_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_transfer record;
BEGIN
  SELECT id, to_user_id, fee_refund_needed_at, fee_refund_id
    INTO v_transfer
    FROM public.ticket_transfers
   WHERE fee_payment_ref = p_reference
   FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_transfer.fee_refund_needed_at IS NULL THEN RETURN; END IF;
  IF v_transfer.fee_refund_id IS NOT NULL THEN RETURN; END IF;

  UPDATE public.ticket_transfers
     SET fee_refund_id = p_refund_id, fee_refund_status = 'processing'
   WHERE id = v_transfer.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'transfer_fee_refund_initiated', v_transfer.to_user_id,
          jsonb_build_object('transfer_id', v_transfer.id, 'refund_id', p_refund_id, 'paystack_reference', p_reference),
          'webhook');
END;
$function$
;

REVOKE ALL ON FUNCTION public.attach_transfer_fee_refund_id(text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.attach_transfer_fee_refund_id(text, text) TO project_admin;

-- ---------------------------------------------------------------------
-- mark_transfer_fee_refund_initiation_failed: called when Paystack itself
-- rejects the refund-creation call outright (never got a refund id to
-- track asynchronously). The 'transfer_fee_refund_needed' admin_logs row
-- already exists by this point (written inside confirm_transfer_fee_
-- payment above) -- this adds the follow-up record so the failure is
-- never just a console.error a human has to go find in logs.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_transfer_fee_refund_initiation_failed(p_reference text, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_transfer record;
BEGIN
  SELECT id, to_user_id INTO v_transfer
    FROM public.ticket_transfers
   WHERE fee_payment_ref = p_reference
   FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.ticket_transfers SET fee_refund_status = 'failed' WHERE id = v_transfer.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'transfer_fee_refund_initiation_failed', v_transfer.to_user_id,
          jsonb_build_object('transfer_id', v_transfer.id, 'paystack_reference', p_reference, 'error', p_error),
          'webhook');
END;
$function$
;

REVOKE ALL ON FUNCTION public.mark_transfer_fee_refund_initiation_failed(text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.mark_transfer_fee_refund_initiation_failed(text, text) TO project_admin;

-- ---------------------------------------------------------------------
-- finalize_transfer_fee_refund / fail_transfer_fee_refund: the async
-- completion signal from Paystack's refund.processed/refund.failed
-- webhook events (api/webhook/paystack.ts), keyed by fee_refund_id --
-- exactly mirrors finalize_ticket_refund/fail_ticket_refund's role and
-- idempotency shape for the existing ticket-refund flow.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_transfer_fee_refund(p_refund_id text)
 RETURNS TABLE(status text, recipient_email text, recipient_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_transfer record;
BEGIN
  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE fee_refund_id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_transfer.fee_refund_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.ticket_transfers
     SET fee_refund_status = 'refunded', fee_refund_completed_at = now()
   WHERE id = v_transfer.id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_transfer.to_user_id, 'event_update', 'Transfer fee refunded',
    'Your ticket transfer could not be completed, so your transfer fee was refunded.',
    false, '💸', jsonb_build_object('transferId', v_transfer.id)
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'transfer_fee_refund_finalized', v_transfer.to_user_id,
          jsonb_build_object('transfer_id', v_transfer.id, 'refund_id', p_refund_id), 'webhook');

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_transfer.fee_kobo
    FROM public.users u WHERE u.id = v_transfer.to_user_id;
END;
$function$
;

REVOKE ALL ON FUNCTION public.finalize_transfer_fee_refund(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.finalize_transfer_fee_refund(text) TO project_admin;

CREATE OR REPLACE FUNCTION public.fail_transfer_fee_refund(p_refund_id text, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_transfer record;
BEGIN
  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE fee_refund_id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_transfer.fee_refund_status = 'refunded' THEN RETURN 'already_finalized'; END IF;
  IF v_transfer.fee_refund_status = 'failed' THEN RETURN 'already_failed'; END IF;

  UPDATE public.ticket_transfers SET fee_refund_status = 'failed' WHERE id = v_transfer.id;

  -- The worst case in this whole flow: the automated refund itself
  -- failed. No further automatic recovery is attempted -- this is the
  -- durable, admin-visible record a human needs to find and act on.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'transfer_fee_refund_failed', v_transfer.to_user_id,
          jsonb_build_object('transfer_id', v_transfer.id, 'refund_id', p_refund_id, 'reason', p_reason),
          'webhook');

  RETURN 'failed_recorded';
END;
$function$
;

REVOKE ALL ON FUNCTION public.fail_transfer_fee_refund(text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.fail_transfer_fee_refund(text, text) TO project_admin;
