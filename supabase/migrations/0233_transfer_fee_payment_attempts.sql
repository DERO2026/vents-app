-- 0233: ticket-transfer fee payment attempts (AZ-08, P1).
--
-- Problem (0043 / 0064):
--   * initiate_transfer_fee_payment overwrote ticket_transfers.fee_payment_ref
--     with a fresh 'txf_' reference on every retry, and every later lookup
--     (confirm, owner check, refund bookkeeping) went through that one
--     column. An earlier attempt paid by bank transfer or USSD that
--     completed AFTER a retry matched nothing: confirm returned 'not_found',
--     the webhook answered 200, Paystack stopped retrying, and the money was
--     recorded nowhere.
--   * A second successful payment on a transfer that was already paid
--     returned 'already_paid' and was recorded nowhere either.
--   * A payment of the wrong amount returned 'amount_mismatch' and was only
--     logged by the server.
--
-- Fix:
--   1. ticket_transfer_fee_attempts keeps every attempt's reference forever
--      (one row per reference; never overwritten). Existing references are
--      backfilled.
--   2. initiate_transfer_fee_payment records each new attempt. It still sets
--      fee_payment_ref to the newest attempt while the transfer is pending,
--      so nothing that reads that column changes behaviour.
--   3. confirm_transfer_fee_payment resolves the transfer through the
--      attempt (any attempt, old or new), under the same transfer row lock
--      as before. The FIRST successful payment to land owns the transfer:
--      fee_payment_ref is re-pointed to it before any branch runs, so the
--      existing refund bookkeeping (attach/mark/finalize/fail, keyed by
--      fee_payment_ref) keeps working for a late older attempt.
--      Every other successful payment for the same transfer (a duplicate),
--      an unknown 'txf_' reference and a wrong-amount payment are recorded
--      in payment_exceptions (kind 'ticket_transfer_fee'), idempotently per
--      reference, for the two-admin refund flow. Nothing is refunded
--      automatically for them and no ownership changes twice.
--   4. get_transfer_fee_payment_owner resolves through the attempts, so the
--      buyer's own verify call works for any of their attempts.
--
-- Unchanged: the fee amount, eligibility checks, the ownership swap, the
-- existing automatic refund when a paid transfer can no longer complete
-- (0064), function signatures and grants. The webhook and app code need no
-- change.
--
-- Prerequisites: 0043, 0064, 0226. Refuses if any patched function differs
-- from the repository definition it replaces, or if 0233 is already applied.
-- Rollback: supabase/rollback/undo_0233.sql.

BEGIN;

DO $pre$
DECLARE
  v_pins jsonb := '{"initiate_transfer_fee_payment": "02f938d7ac659268b73ce822752ef400",
                    "get_transfer_fee_payment_owner": "2984c22524a9bb1a1b21a9960447491c",
                    "confirm_transfer_fee_payment": "46f411874adac7e0f55192cc54539a2d"}';
  v_name text;
  v_live text;
BEGIN
  IF to_regclass('public.ticket_transfer_fee_attempts') IS NOT NULL THEN
    RAISE EXCEPTION '0233 already applied (ticket_transfer_fee_attempts exists); refusing to run twice';
  END IF;
  IF to_regclass('public.payment_exceptions') IS NULL THEN
    RAISE EXCEPTION '0233 requires 0226 (payment_exceptions is missing)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'ticket_transfers' AND column_name = 'fee_refund_needed_at') THEN
    RAISE EXCEPTION '0233 requires 0064 (ticket_transfers.fee_refund_needed_at is missing)';
  END IF;
  FOR v_name IN SELECT jsonb_object_keys(v_pins) LOOP
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_live IS DISTINCT FROM v_pins->>v_name THEN
      RAISE EXCEPTION '0233 refused: public.% is not the expected version (live md5 %, expected %)',
        v_name, COALESCE(v_live, 'missing'), v_pins->>v_name;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. Every attempt, kept ───────────────────────────────────────────────────
CREATE TABLE public.ticket_transfer_fee_attempts (
  reference   text PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES public.ticket_transfers(id),
  fee_kobo    bigint NOT NULL CHECK (fee_kobo >= 0),
  payer_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- What happened when Paystack reported this reference as paid.
  outcome     text CHECK (outcome IN ('paid', 'duplicate', 'amount_mismatch')),
  paid_kobo   bigint,
  outcome_at  timestamptz
);
CREATE INDEX ticket_transfer_fee_attempts_transfer_idx ON public.ticket_transfer_fee_attempts (transfer_id);
ALTER TABLE public.ticket_transfer_fee_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: clients never read or write this table directly.
REVOKE ALL ON public.ticket_transfer_fee_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ticket_transfer_fee_attempts TO project_admin;

INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id, created_at, outcome, outcome_at)
SELECT t.fee_payment_ref, t.id, t.fee_kobo, t.to_user_id, t.created_at,
       CASE WHEN t.fee_paid_at IS NOT NULL OR t.fee_refund_needed_at IS NOT NULL THEN 'paid' END,
       COALESCE(t.fee_paid_at, t.fee_refund_needed_at)
  FROM public.ticket_transfers t
 WHERE t.fee_payment_ref IS NOT NULL;

-- ── 2. payment_exceptions learns about transfer fees ─────────────────────────
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_kind_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_kind_check
  CHECK (kind IN ('ticket_purchase', 'ticket_transfer_fee'));
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_reason_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_reason_check
  CHECK (reason IN ('not_found', 'amount_mismatch', 'duplicate_payment'));
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_source_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_source_check
  CHECK (source IN ('verify', 'webhook', 'server'));
ALTER TABLE public.payment_exceptions ADD COLUMN transfer_id uuid REFERENCES public.ticket_transfers(id) ON DELETE SET NULL;

-- Internal: one row per Paystack reference, idempotent (a webhook retry only
-- bumps seen_count). Never callable by a client.
CREATE FUNCTION public.record_transfer_fee_payment_exception(
  p_reference text, p_transfer_id uuid, p_reason text, p_amount_kobo bigint, p_expected_kobo bigint, p_detail text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_payer uuid;
  v_event uuid;
  v_new   boolean;
BEGIN
  SELECT t.to_user_id, k.event_id INTO v_payer, v_event
    FROM public.ticket_transfers t LEFT JOIN public.tickets k ON k.id = t.ticket_id
   WHERE t.id = p_transfer_id;
  INSERT INTO public.payment_exceptions
    (reference, kind, reason, detail, amount_kobo, expected_kobo, user_id, event_id, source, transfer_id)
  VALUES
    (p_reference, 'ticket_transfer_fee', p_reason, left(p_detail, 500), GREATEST(COALESCE(p_amount_kobo, 0), 0),
     p_expected_kobo, v_payer, v_event, 'server', p_transfer_id)
  ON CONFLICT (reference) DO UPDATE
     SET last_seen_at = now(),
         seen_count   = public.payment_exceptions.seen_count + 1
  RETURNING (xmax = 0) INTO v_new;
  IF v_new THEN
    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (NULL, 'transfer_fee_payment_exception', v_payer,
            jsonb_build_object('paystack_reference', p_reference, 'transfer_id', p_transfer_id, 'reason', p_reason,
                               'amount_kobo', p_amount_kobo, 'expected_kobo', p_expected_kobo),
            'webhook');
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_transfer_fee_payment_exception(text, uuid, text, bigint, bigint, text) FROM PUBLIC, anon, authenticated, project_admin;

-- ── 3. initiate: record the attempt ──────────────────────────────────────────
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

  -- [0233] Every attempt is kept: an earlier attempt that completes later
  -- (bank transfer, USSD) is still matched by confirm_transfer_fee_payment.
  INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id)
  VALUES (v_ref, p_transfer_id, v_transfer.fee_kobo, v_uid);

  UPDATE public.ticket_transfers
     SET fee_payment_ref = v_ref
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('reference', v_ref, 'feeKobo', v_transfer.fee_kobo);
END;
$function$;

-- ── 4. owner lookup: any attempt ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_transfer_fee_payment_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- [0233] Resolved through the attempt, so every attempt the recipient made
  -- can be verified, not only the newest.
  SELECT COALESCE(
    (SELECT t.to_user_id FROM public.ticket_transfer_fee_attempts a
       JOIN public.ticket_transfers t ON t.id = a.transfer_id
      WHERE a.reference = p_reference),
    (SELECT to_user_id FROM public.ticket_transfers WHERE fee_payment_ref = p_reference));
$function$;

-- ── 5. confirm: any attempt; first payment owns the transfer ─────────────────
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

COMMIT;
