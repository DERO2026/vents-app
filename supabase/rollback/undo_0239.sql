-- Undo 0239 only (supabase/migrations/0239_transfer_fee_payment_safety_live.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0239';
--   \i supabase/rollback/undo_0239.sql
--
-- Restores, byte for byte, the three functions production ran before 0239:
-- confirm_transfer_fee_payment (0043 + the reviewed live amount edit, md5
-- 5baaac00...), initiate_transfer_fee_payment and
-- get_transfer_fee_payment_owner (0043).
--
-- Financial records are NEVER deleted. If any transfer-fee payment was
-- recorded (an attempt with an outcome, a transfer-fee payment exception, a
-- transfer owing a refund), the attempts table, the transfer refund columns
-- and payment_exceptions' transfer-fee kind/reasons/transfer_id are kept as
-- evidence; only the functions go back. With nothing recorded, the schema is
-- returned to exactly 0226's.
--
-- Refuses while 0234 is applied (it needs payment_exceptions.transfer_id;
-- undo 0240 and 0234 first, reverse order only).
BEGIN;
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0239' THEN
    RAISE EXCEPTION 'undo_0239 refused: set vents.rollback_confirm = ''undo-0239'' to confirm';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.confirm_transfer_fee_payment(text,bigint)')
                  AND position('[0239]' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'undo_0239 refused: 0239 is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'payment_exceptions' AND column_name = 'refund_status') THEN
    RAISE EXCEPTION 'undo_0239 refused: 0234 is still applied (undo 0240, then 0234, first)';
  END IF;
END
$undo$;

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
BEGIN
  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE fee_payment_ref = p_reference FOR UPDATE;
  IF v_transfer.id IS NULL THEN RETURN 'not_found'; END IF;

  IF v_transfer.fee_paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;

  IF v_transfer.status <> 'pending' THEN
    RETURN 'transfer_not_pending:' || v_transfer.status;
  END IF;

  IF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = v_transfer.id;
    RETURN 'expired';
  END IF;

  IF p_amount_kobo < v_transfer.fee_kobo THEN
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
    RETURN 'ticket_ineligible';
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
    RETURN 'ticket_ineligible';
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

CREATE OR REPLACE FUNCTION public.get_transfer_fee_payment_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT to_user_id FROM public.ticket_transfers WHERE fee_payment_ref = p_reference;
$function$;

DROP FUNCTION IF EXISTS public.ticket_transfer_fee_attempt_outcome(text, uuid, bigint, uuid, text, bigint, text);

DO $schema$
DECLARE
  v_records boolean;
BEGIN
  v_records := EXISTS (SELECT 1 FROM public.ticket_transfer_fee_attempts WHERE outcome IS NOT NULL AND answer IS NOT NULL
                         AND NOT (outcome = 'paid' AND answer = 'confirmed' AND paid_kobo IS NULL))
            OR EXISTS (SELECT 1 FROM public.payment_exceptions WHERE kind = 'ticket_transfer_fee')
            OR EXISTS (SELECT 1 FROM public.ticket_transfers WHERE fee_refund_needed_at IS NOT NULL);
  IF v_records THEN
    RAISE NOTICE 'undo_0239: transfer-fee payments were recorded; the attempts table, transfer refund columns and transfer-fee exceptions are KEPT as evidence (functions restored)';
    RETURN;
  END IF;
  DROP FUNCTION public.record_transfer_fee_payment_exception(text, uuid, text, bigint, bigint, text);
  DROP TABLE public.ticket_transfer_fee_attempts;
  DROP FUNCTION public.ticket_transfer_fee_attempts_immutable();
  ALTER TABLE public.payment_exceptions DROP COLUMN transfer_id;
  ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_kind_check;
  ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_kind_check CHECK (kind IN ('ticket_purchase'));
  ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_reason_check;
  ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_reason_check CHECK (reason IN ('not_found', 'amount_mismatch'));
  ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_source_check;
  ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_source_check CHECK (source IN ('verify', 'webhook'));
  DROP INDEX public.ticket_transfers_fee_refund_id_idx;
  ALTER TABLE public.ticket_transfers DROP COLUMN fee_refund_needed_at, DROP COLUMN fee_refund_id,
    DROP COLUMN fee_refund_status, DROP COLUMN fee_refund_completed_at;
  RAISE NOTICE 'undo_0239: nothing was recorded; schema returned to 0226';
END
$schema$;
COMMIT;
