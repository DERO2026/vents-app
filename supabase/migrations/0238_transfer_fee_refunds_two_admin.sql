-- 0238: transfer-fee refunds follow the two-admin rule (owner, 2026-11-27).
--
-- Before: when a recipient paid a ticket-transfer fee but the transfer could
-- no longer complete (the sender cancelled, the request expired, the ticket
-- became ineligible), confirm_transfer_fee_payment claimed the refund with a
-- ':refund_claimed' suffix and api/webhook/paystack.ts refunded it through
-- Paystack automatically, with no admin involved (0064).
--
-- Owner decision (2026-11-27): automatic transfer-fee refunds must follow the
-- two-admin approval policy (D4 / P4), like every other payment that bought
-- nothing.
--
-- Now:
--   1. The same three situations record a payment exception (kind
--      'ticket_transfer_fee', reason 'transfer_not_completed') for the exact
--      reference and amount Paystack charged, and mark the transfer
--      fee_refund_status = 'awaiting_approval'. The suffix is ':refund_queued'.
--      The webhook never calls Paystack for it. The record is created
--      automatically, so a refund can't be forgotten.
--   2. The refund then goes through 0234 unchanged: one admin or sub-admin
--      requests it, a DIFFERENT Super Admin approves it (bound to reference,
--      amount <= captured and reason), a Super Admin sends it to Paystack
--      once, and Paystack's webhook closes it. No single person can do both
--      approvals.
--   3. Paystack's refund.processed / refund.failed for such a refund also
--      updates the transfer (fee_refund_status 'refunded' / 'failed') and
--      tells the recipient their fee was refunded, as 0064 did.
--   4. Backfill: transfers whose automatic refund never started or failed
--      (fee_refund_status 'needed' with no refund id, or 'failed') get the
--      same payment exception, so money already owed is in the queue too.
--      Refunds already in flight at Paystack ('processing') are left to
--      finish through 0064's webhook functions, unchanged.
--
-- Unchanged: duplicate / unknown / wrong-amount handling (0233), the first
-- payment owning the transfer, the ownership swap, and every 0064 refund
-- bookkeeping function (still used by refunds already in flight).
--
-- Prerequisites: 0233 and 0234 (md5-pinned). Refuses if already applied.
-- Rollback: supabase/rollback/undo_0238.sql.

BEGIN;

DO $pre$
DECLARE
  v_pins jsonb := '{"confirm_transfer_fee_payment": "99d89944166a06b9f6c44289634c2c7f",
                    "finalize_payment_exception_refund": "5054801cd73750349ed99310519aaf8e",
                    "fail_payment_exception_refund": "099e94c90aacac4e70bb6bc925cf94e2"}';
  v_name text;
  v_live text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.confirm_transfer_fee_payment(text,bigint)')
              AND position('[0238]' IN prosrc) > 0) THEN
    RAISE EXCEPTION '0238 already applied; refusing to run twice';
  END IF;
  IF to_regclass('public.ticket_transfer_fee_attempts') IS NULL THEN
    RAISE EXCEPTION '0238 requires 0233';
  END IF;
  FOR v_name IN SELECT jsonb_object_keys(v_pins) LOOP
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_live IS DISTINCT FROM v_pins->>v_name THEN
      RAISE EXCEPTION '0238 refused: public.% is not the expected version (live md5 %, expected %; are 0233 and 0234 applied?)',
        v_name, COALESCE(v_live, 'missing'), v_pins->>v_name;
    END IF;
  END LOOP;
END
$pre$;

ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_reason_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_reason_check
  CHECK (reason IN ('not_found', 'amount_mismatch', 'duplicate_payment', 'transfer_not_completed'));

-- ── 1. confirm: queue the refund instead of claiming an automatic one ────────
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
         SET fee_refund_needed_at = now(), fee_refund_status = 'awaiting_approval'
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
      -- [0238] No automatic refund: the paid fee is owed back, so it becomes
      -- a payment exception that two admins must approve (D4 / P4).
      PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'transfer_not_completed',
        p_amount_kobo, v_transfer.fee_kobo, 'The ticket transfer could not complete after the fee was paid');
      v_claimed := true;
    END IF;
    RETURN 'transfer_not_pending:' || v_transfer.status || (CASE WHEN v_claimed THEN ':refund_queued' ELSE '' END);
  END IF;

  IF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = v_transfer.id;
    v_claimed := false;
    IF v_transfer.fee_refund_needed_at IS NULL THEN
      UPDATE public.ticket_transfers
         SET fee_refund_needed_at = now(), fee_refund_status = 'awaiting_approval'
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
      -- [0238] No automatic refund: the paid fee is owed back, so it becomes
      -- a payment exception that two admins must approve (D4 / P4).
      PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'transfer_not_completed',
        p_amount_kobo, v_transfer.fee_kobo, 'The ticket transfer could not complete after the fee was paid');
      v_claimed := true;
    END IF;
    RETURN 'expired' || (CASE WHEN v_claimed THEN ':refund_queued' ELSE '' END);
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
         SET fee_refund_needed_at = now(), fee_refund_status = 'awaiting_approval'
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
      -- [0238] No automatic refund: the paid fee is owed back, so it becomes
      -- a payment exception that two admins must approve (D4 / P4).
      PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'transfer_not_completed',
        p_amount_kobo, v_transfer.fee_kobo, 'The ticket transfer could not complete after the fee was paid');
      v_claimed := true;
    END IF;
    RETURN 'ticket_ineligible' || (CASE WHEN v_claimed THEN ':refund_queued' ELSE '' END);
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
         SET fee_refund_needed_at = now(), fee_refund_status = 'awaiting_approval'
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
      -- [0238] No automatic refund: the paid fee is owed back, so it becomes
      -- a payment exception that two admins must approve (D4 / P4).
      PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'transfer_not_completed',
        p_amount_kobo, v_transfer.fee_kobo, 'The ticket transfer could not complete after the fee was paid');
      v_claimed := true;
    END IF;
    RETURN 'ticket_ineligible' || (CASE WHEN v_claimed THEN ':refund_queued' ELSE '' END);
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

-- ── 3. Paystack's refund outcome also updates the transfer ───────────────────
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
  -- [0238] A transfer that could not complete: the transfer shows the refund
  -- as done and the recipient is told, as the automatic refund (0064) did.
  IF x.reason = 'transfer_not_completed' AND x.transfer_id IS NOT NULL THEN
    UPDATE public.ticket_transfers t
       SET fee_refund_status = 'refunded', fee_refund_completed_at = now()
     WHERE t.id = x.transfer_id;
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    SELECT t.to_user_id, 'event_update', 'Transfer fee refunded',
           'Your ticket transfer could not be completed, so your transfer fee was refunded.',
           false, '💸', jsonb_build_object('transferId', t.id)
      FROM public.ticket_transfers t WHERE t.id = x.transfer_id;
  END IF;
  RETURN QUERY SELECT 'finalized'::text, u.email, u.full_name, x.refund_amount_kobo
    FROM (SELECT 1) one LEFT JOIN public.users u ON u.id = x.user_id;
END;
$function$;

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
  UPDATE public.payment_exceptions e
     SET refund_status = 'refund_failed', refund_error = left(COALESCE(p_reason, 'refund failed'), 500), refund_id = NULL
   WHERE e.id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (NULL, 'payment_exception_refund_failed', x.user_id,
          jsonb_build_object('payment_exception_id', x.id, 'reference', x.reference, 'refund_id', p_refund_id,
                             'reason', p_reason),
          'webhook');
  -- [0238] Keep the transfer's own refund state traceable.
  IF x.reason = 'transfer_not_completed' AND x.transfer_id IS NOT NULL THEN
    UPDATE public.ticket_transfers t SET fee_refund_status = 'failed' WHERE t.id = x.transfer_id;
  END IF;
  RETURN 'failed_recorded';
END;
$function$;

-- ── 4. Backfill: automatic refunds that never started, or failed ─────────────
DO $backfill$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT t.id, t.fee_payment_ref, t.fee_kobo,
           COALESCE((SELECT a.paid_kobo FROM public.ticket_transfer_fee_attempts a WHERE a.reference = t.fee_payment_ref), t.fee_kobo) AS paid_kobo
      FROM public.ticket_transfers t
     WHERE t.fee_refund_needed_at IS NOT NULL
       AND t.fee_payment_ref IS NOT NULL
       AND ((t.fee_refund_status = 'needed' AND t.fee_refund_id IS NULL) OR t.fee_refund_status = 'failed')
       AND NOT EXISTS (SELECT 1 FROM public.payment_exceptions x WHERE x.reference = t.fee_payment_ref)
  LOOP
    PERFORM public.record_transfer_fee_payment_exception(r.fee_payment_ref, r.id, 'transfer_not_completed', r.paid_kobo, r.fee_kobo,
      'Automatic transfer-fee refund never completed (moved to two-admin approval by 0238)');
    UPDATE public.ticket_transfers SET fee_refund_status = 'awaiting_approval' WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0238: % owed transfer-fee refund(s) moved to the two-admin queue', n;
END
$backfill$;

COMMIT;
