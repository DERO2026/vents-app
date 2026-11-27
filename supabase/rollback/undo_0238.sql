-- Undo 0238. Gated: run with SET vents.rollback_confirm = 'undo-0238';
-- Restores 0233's confirm_transfer_fee_payment and 0234's
-- finalize_/fail_payment_exception_refund verbatim. Existing
-- 'transfer_not_completed' payment exceptions stay (they are money owed and
-- remain refundable through the two-admin flow), so the widened reason check
-- is kept. Transfers already marked 'awaiting_approval' keep that state.
-- WARNING: after undo, a transfer that can't complete after its fee was paid
-- is again refunded AUTOMATICALLY by the webhook, against the owner's
-- 2026-11-27 decision that these refunds need two admins.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0238' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0238'' first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.confirm_transfer_fee_payment(text,bigint)')
                  AND position('[0238]' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'undo_0238: 0238 is not applied';
  END IF;
END $$;

-- 0233, verbatim.
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
  v_transfer_id uuid;
BEGIN
  -- [0233] Resolve the transfer through the attempt (any attempt, old or new).
  SELECT a.transfer_id INTO v_transfer_id FROM public.ticket_transfer_fee_attempts a WHERE a.reference = p_reference;
  IF v_transfer_id IS NULL THEN
    SELECT t.id INTO v_transfer_id FROM public.ticket_transfers t WHERE t.fee_payment_ref = p_reference;
  END IF;
  IF v_transfer_id IS NULL THEN
    -- A captured transfer-fee payment nobody can match: record it so it is
    -- refunded through the two-admin flow instead of disappearing.
    IF p_reference LIKE 'txf\_%' THEN
      PERFORM public.record_transfer_fee_payment_exception(p_reference, NULL, 'not_found', p_amount_kobo, NULL,
        'No ticket transfer matches this transfer-fee reference');
    END IF;
    RETURN 'not_found';
  END IF;

  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE id = v_transfer_id FOR UPDATE;

  -- [0233] A payment already landed on this transfer (paid, or claimed for a
  -- refund). The same reference again is a replay (unchanged answers); any
  -- other reference is a second, duplicate payment.
  IF v_transfer.fee_paid_at IS NOT NULL OR v_transfer.fee_refund_needed_at IS NOT NULL THEN
    IF v_transfer.fee_payment_ref IS NOT DISTINCT FROM p_reference THEN
      IF v_transfer.fee_paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;
      RETURN 'transfer_not_pending:' || v_transfer.status;
    END IF;
    UPDATE public.ticket_transfer_fee_attempts
       SET outcome = 'duplicate', paid_kobo = p_amount_kobo, outcome_at = COALESCE(outcome_at, now())
     WHERE reference = p_reference;
    PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'duplicate_payment', p_amount_kobo,
      v_transfer.fee_kobo, 'This transfer was already paid by reference ' || COALESCE(v_transfer.fee_payment_ref, '?'));
    RETURN 'duplicate_payment';
  END IF;

  -- [0233] Wrong amount: recorded, never applied; the transfer stays as it is.
  IF p_amount_kobo IS DISTINCT FROM v_transfer.fee_kobo AND v_transfer.status = 'pending' AND v_transfer.expires_at >= now() THEN
    UPDATE public.ticket_transfer_fee_attempts
       SET outcome = 'amount_mismatch', paid_kobo = p_amount_kobo, outcome_at = COALESCE(outcome_at, now())
     WHERE reference = p_reference;
    PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'amount_mismatch', p_amount_kobo,
      v_transfer.fee_kobo, 'Charged amount differs from the transfer fee');
    RETURN 'amount_mismatch:' || v_transfer.fee_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  -- [0233] This is the first payment to land: it owns the transfer. Re-point
  -- fee_payment_ref so the existing refund bookkeeping (keyed by it) follows
  -- the reference that actually paid.
  IF v_transfer.fee_payment_ref IS DISTINCT FROM p_reference THEN
    UPDATE public.ticket_transfers SET fee_payment_ref = p_reference WHERE id = v_transfer.id;
    v_transfer.fee_payment_ref := p_reference;
  END IF;
  UPDATE public.ticket_transfer_fee_attempts
     SET outcome = 'paid', paid_kobo = p_amount_kobo, outcome_at = now()
   WHERE reference = p_reference;
  IF NOT FOUND THEN
    INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id, outcome, paid_kobo, outcome_at)
    VALUES (p_reference, v_transfer.id, v_transfer.fee_kobo, v_transfer.to_user_id, 'paid', p_amount_kobo, now());
  END IF;

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
$function$;

-- 0234, verbatim.
CREATE OR REPLACE FUNCTION public.finalize_payment_exception_refund(p_refund_id text)
RETURNS TABLE(status text, buyer_email text, buyer_name text, amount_kobo bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  x public.payment_exceptions%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.payment_exceptions e WHERE e.refund_id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  IF x.refund_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint; RETURN;
  END IF;
  UPDATE public.payment_exceptions e
     SET refund_status = 'refunded', refund_completed_at = now(),
         status = 'resolved', resolved_at = now(), resolved_by = x.refund_approved_by,
         resolution_note = left('Refunded ₦' || to_char(x.refund_amount_kobo / 100.0, 'FM999,999,999,990.00')
                                || ' (Paystack refund ' || p_refund_id || '); requested by ' || x.refund_requested_by
                                || ', approved by ' || x.refund_approved_by || '. Reason: ' || x.refund_reason, 1000)
   WHERE e.id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'payment_exception_refunded', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'refund_id', p_refund_id,
                             'amount_kobo', x.refund_amount_kobo),
          'webhook');
  RETURN QUERY SELECT 'finalized'::text, u.email, u.full_name, x.refund_amount_kobo
    FROM (SELECT 1) one LEFT JOIN public.users u ON u.id = x.user_id;
END;
$function$;

-- 0234, verbatim.
CREATE OR REPLACE FUNCTION public.fail_payment_exception_refund(p_refund_id text, p_reason text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  x public.payment_exceptions%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.payment_exceptions e WHERE e.refund_id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF x.refund_status = 'refunded' THEN RETURN 'already_finalized'; END IF;
  IF x.refund_status = 'refund_failed' THEN RETURN 'already_failed'; END IF;
  -- The exception stays open; the money is still owed. A new two-admin
  -- request is needed to try again. refund_id is cleared so a new attempt
  -- can record its own id; the failed id stays in admin_logs.
  UPDATE public.payment_exceptions e
     SET refund_status = 'refund_failed', refund_error = left(COALESCE(p_reason, 'refund failed'), 500), refund_id = NULL
   WHERE e.id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'payment_exception_refund_failed', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'refund_id', p_refund_id,
                             'reason', p_reason),
          'webhook');
  RETURN 'failed_recorded';
END;
$function$;

COMMIT;
