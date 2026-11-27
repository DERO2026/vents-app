-- Undo 0233 (ticket-transfer fee payment attempts, AZ-08). Gated: run with
--   SET vents.rollback_confirm = 'undo-0233';
-- Restores the 0043/0064 definitions of initiate_transfer_fee_payment,
-- get_transfer_fee_payment_owner and confirm_transfer_fee_payment verbatim,
-- and removes the attempts table, the transfer-fee exception kind and its
-- helper. Refuses while any transfer-fee payment exception or any attempt
-- recorded as a duplicate or wrong-amount payment exists: those are money
-- records that must be resolved (refunded) first, not deleted.
-- WARNING: after undo a retry again overwrites the earlier reference, so a
-- late payment of an earlier attempt is matched to nothing.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0233' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0233'' first';
  END IF;
  IF to_regclass('public.ticket_transfer_fee_attempts') IS NULL THEN
    RAISE EXCEPTION 'undo_0233: 0233 is not applied (ticket_transfer_fee_attempts is missing)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_exceptions WHERE kind = 'ticket_transfer_fee') THEN
    RAISE EXCEPTION 'undo_0233: transfer-fee payment exceptions exist; resolve them before undoing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ticket_transfer_fee_attempts WHERE outcome IN ('duplicate', 'amount_mismatch')) THEN
    RAISE EXCEPTION 'undo_0233: duplicate or wrong-amount transfer-fee payments are recorded; resolve them before undoing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_exceptions WHERE reason = 'duplicate_payment' OR source = 'server') THEN
    RAISE EXCEPTION 'undo_0233: payment exceptions use values 0226 does not allow; resolve them before undoing';
  END IF;
END $$;

-- 0043, verbatim.
CREATE OR REPLACE FUNCTION public.initiate_transfer_fee_payment(p_transfer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_transfer record;
  v_ref      text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM public.check_rate_limit('transfer_fee_init:' || v_uid::text, 10, 3600);

  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_transfer.to_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the intended recipient can pay for this transfer';
  END IF;
  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending (status: %)', v_transfer.status;
  END IF;
  IF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = p_transfer_id;
    RAISE EXCEPTION 'This transfer request has expired';
  END IF;

  v_ref := 'txf_' || replace(gen_random_uuid()::text, '-', '');

  UPDATE public.ticket_transfers
     SET fee_payment_ref = v_ref
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('reference', v_ref, 'feeKobo', v_transfer.fee_kobo);
END;
$function$;

-- 0043, verbatim.
CREATE OR REPLACE FUNCTION public.get_transfer_fee_payment_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT to_user_id FROM public.ticket_transfers WHERE fee_payment_ref = p_reference;
$function$;

-- 0064, verbatim.
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
$function$;

DROP FUNCTION public.record_transfer_fee_payment_exception(text, uuid, text, bigint, bigint, text);
ALTER TABLE public.payment_exceptions DROP COLUMN transfer_id;
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_kind_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_kind_check CHECK (kind IN ('ticket_purchase'));
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_reason_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_reason_check CHECK (reason IN ('not_found', 'amount_mismatch'));
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_source_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_source_check CHECK (source IN ('verify', 'webhook'));
DROP TABLE public.ticket_transfer_fee_attempts;

COMMIT;
