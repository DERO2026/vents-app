-- 0239: ticket-transfer fee payments, rebased on the LIVE production function
-- (owner decisions 2026-11-27). Replaces 0064 + 0233 + 0238 for production;
-- none of those three is ever applied there.
--
-- Production (read-only inspection, 2026-11-27):
--   * confirm_transfer_fee_payment is 0043's version with one untracked edit
--     (md5 5baaac006d1757b42b2f587315ce6a3f): the amount check is
--     `p_amount_kobo < fee_kobo` (any amount at or above the fee completes
--     the transfer), not 0043's strict `IS DISTINCT FROM`. Owner: KEEP it.
--   * initiate_transfer_fee_payment / get_transfer_fee_payment_owner are
--     exactly 0043's (02f938d7..., 2984c225...).
--   * 0064 was never applied: no fee_refund_* columns, no refund functions.
--     So a paid fee whose transfer could not complete (expired, cancelled,
--     declined, ineligible ticket), an underpayment, a payment under a
--     replaced reference and an overpayment's excess were all recorded
--     NOWHERE except at Paystack.
--
-- What 0239 does (every outcome is recorded; nothing is refunded here):
--   1. ticket_transfer_fee_attempts: every reference ever issued, kept
--      forever (initiate used to overwrite fee_payment_ref). Existing
--      references are backfilled.
--   2. confirm_transfer_fee_payment keeps the live order and rules -- the
--      `<` acceptance rule included -- and records, in payment_exceptions
--      (kind 'ticket_transfer_fee', one row per Paystack reference,
--      idempotent), every payment that bought nothing or too much:
--        overpayment             transfer completes; ONLY the excess
--                                (paid - fee) is recorded as refundable
--                                ('confirmed:excess_refund_queued');
--        amount_mismatch         underpaid (or no amount): nothing changes,
--                                the whole amount paid is refundable;
--        duplicate_payment       a second payment for a transfer already
--                                paid (or already closed after a payment);
--        transfer_not_completed  late payment: the transfer had expired,
--                                was cancelled/declined/accepted, or the
--                                ticket became ineligible;
--        not_found               a 'txf_' reference nobody can match.
--      Every such answer carries ':refund_queued' (or
--      ':excess_refund_queued'), INCLUDING on a webhook/verify replay, so
--      the app only ever says "recorded" when a record exists.
--   3. Refunds are never made automatically. They go through 0234 (applied
--      after this migration): a request, approval by a DIFFERENT Super
--      Admin, one send to Paystack (refund_id unique), webhook closes it.
--      0234's cap `refund_amount_kobo <= amount_kobo` therefore caps an
--      overpayment refund at the excess.
--   4. Every original Paystack reference stays: the attempt row is never
--      deleted, the exception keeps the reference, and the transfer's
--      fee_payment_ref is re-pointed to the reference that actually paid.
--   5. ticket_transfers gains 0064's four refund columns so a transfer shows
--      its refund state ('awaiting_approval' -> 'refunded' / 'failed', the
--      last two set by 0240 after 0234).
--   6. payment_exceptions gains transfer_id and the transfer-fee kind and
--      reasons (what 0234's precheck requires).
--
-- Unchanged: fee amounts, eligibility, the ownership swap and its row locks,
-- the sender's notification, signatures and grants.
--
-- Order: 0226 -> 0239 -> 0234 -> 0240. Refuses unless the three functions
-- are byte-identical to the reviewed live versions, 0226 is applied, and
-- none of 0064 / 0233 / 0238 / 0239 is. One transaction.
-- Rollback: supabase/rollback/undo_0239.sql.

BEGIN;

DO $pre$
DECLARE
  v_pins jsonb := '{"confirm_transfer_fee_payment": "5baaac006d1757b42b2f587315ce6a3f",
                    "initiate_transfer_fee_payment": "02f938d7ac659268b73ce822752ef400",
                    "get_transfer_fee_payment_owner": "2984c22524a9bb1a1b21a9960447491c"}';
  v_name text;
  v_live text;
BEGIN
  IF to_regclass('public.ticket_transfer_fee_attempts') IS NOT NULL THEN
    RAISE EXCEPTION '0239 refused: ticket_transfer_fee_attempts exists (0233 or 0239 already applied)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'ticket_transfers' AND column_name LIKE 'fee\_refund\_%') THEN
    RAISE EXCEPTION '0239 refused: ticket_transfers already has fee_refund_* columns (0064 partly or fully applied); stop and investigate';
  END IF;
  IF to_regclass('public.payment_exceptions') IS NULL OR to_regprocedure('public.record_payment_exception(text,text,text,text,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION '0239 requires 0226 (payment_exceptions)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'payment_exceptions' AND column_name IN ('transfer_id', 'refund_status')) THEN
    RAISE EXCEPTION '0239 refused: payment_exceptions already has transfer_id/refund_status (0233/0234 applied); apply 0239 right after 0226';
  END IF;
  FOR v_name IN SELECT jsonb_object_keys(v_pins) LOOP
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_live IS DISTINCT FROM v_pins->>v_name THEN
      RAISE EXCEPTION '0239 refused: public.% is not the reviewed live version (live md5 %, expected %)',
        v_name, COALESCE(v_live, 'missing'), v_pins->>v_name;
    END IF;
  END LOOP;
END
$pre$;

-- ── 1. The transfer shows its refund state (0064's columns, nothing else) ────
ALTER TABLE public.ticket_transfers
  ADD COLUMN fee_refund_needed_at    timestamptz,
  ADD COLUMN fee_refund_id           text,
  ADD COLUMN fee_refund_status       text CHECK (fee_refund_status IN ('awaiting_approval', 'refunded', 'failed')),
  ADD COLUMN fee_refund_completed_at timestamptz;
CREATE UNIQUE INDEX ticket_transfers_fee_refund_id_idx ON public.ticket_transfers (fee_refund_id) WHERE fee_refund_id IS NOT NULL;

-- ── 2. Every attempt, kept ───────────────────────────────────────────────────
CREATE TABLE public.ticket_transfer_fee_attempts (
  reference   text PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES public.ticket_transfers(id),
  fee_kobo    bigint NOT NULL CHECK (fee_kobo >= 0),
  payer_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- What happened when Paystack reported this reference as paid.
  outcome     text CHECK (outcome IN ('paid', 'overpaid', 'underpaid', 'duplicate', 'late')),
  paid_kobo   bigint,
  outcome_at  timestamptz,
  -- The exact answer confirm_transfer_fee_payment gave the first time; every
  -- replay (webhook retry, verify after webhook) returns it unchanged.
  answer      text,
  CHECK ((outcome IS NULL) = (outcome_at IS NULL))
);
CREATE INDEX ticket_transfer_fee_attempts_transfer_idx ON public.ticket_transfer_fee_attempts (transfer_id);
ALTER TABLE public.ticket_transfer_fee_attempts ENABLE ROW LEVEL SECURITY;
-- No policies: clients never read or write this table directly.
REVOKE ALL ON public.ticket_transfer_fee_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ticket_transfer_fee_attempts TO project_admin;
-- History is evidence: an attempt is never deleted or re-keyed.
CREATE FUNCTION public.ticket_transfer_fee_attempts_immutable()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Transfer-fee attempts cannot be deleted (reference %)', OLD.reference; END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
     OR NEW.fee_kobo IS DISTINCT FROM OLD.fee_kobo OR NEW.payer_id IS DISTINCT FROM OLD.payer_id THEN
    RAISE EXCEPTION 'Transfer-fee attempt % is immutable', OLD.reference;
  END IF;
  IF OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.paid_kobo IS DISTINCT FROM OLD.paid_kobo
                                 OR NEW.answer IS DISTINCT FROM OLD.answer OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at) THEN
    RAISE EXCEPTION 'Transfer-fee attempt % already has an outcome', OLD.reference;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.ticket_transfer_fee_attempts_immutable() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticket_transfer_fee_attempts_immutable BEFORE UPDATE OR DELETE ON public.ticket_transfer_fee_attempts
  FOR EACH ROW EXECUTE FUNCTION public.ticket_transfer_fee_attempts_immutable();

-- Backfill the one reference each transfer still holds. A transfer whose fee
-- was confirmed is 'paid'; the live function never stored the amount.
INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id, created_at, outcome, outcome_at, answer)
SELECT t.fee_payment_ref, t.id, t.fee_kobo, t.to_user_id, t.created_at,
       CASE WHEN t.fee_paid_at IS NOT NULL THEN 'paid' END, t.fee_paid_at,
       CASE WHEN t.fee_paid_at IS NOT NULL THEN 'confirmed' END
  FROM public.ticket_transfers t
 WHERE t.fee_payment_ref IS NOT NULL;

-- ── 3. payment_exceptions learns about transfer fees ─────────────────────────
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_kind_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_kind_check
  CHECK (kind IN ('ticket_purchase', 'ticket_transfer_fee'));
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_reason_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_reason_check
  CHECK (reason IN ('not_found', 'amount_mismatch', 'duplicate_payment', 'transfer_not_completed', 'overpayment'));
ALTER TABLE public.payment_exceptions DROP CONSTRAINT payment_exceptions_source_check;
ALTER TABLE public.payment_exceptions ADD CONSTRAINT payment_exceptions_source_check
  CHECK (source IN ('verify', 'webhook', 'server'));
ALTER TABLE public.payment_exceptions ADD COLUMN transfer_id uuid REFERENCES public.ticket_transfers(id) ON DELETE SET NULL;

-- Internal: one row per Paystack reference, idempotent (a replay only bumps
-- seen_count; the first record's amount is never changed). Never callable
-- by a client.
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

-- ── 4. initiate: record the attempt (0043 otherwise unchanged) ───────────────
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

  -- [0239] Every attempt is kept: an earlier attempt that completes later
  -- (bank transfer, USSD) is still matched by confirm_transfer_fee_payment.
  INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id)
  VALUES (v_ref, p_transfer_id, v_transfer.fee_kobo, v_uid);

  UPDATE public.ticket_transfers
     SET fee_payment_ref = v_ref
   WHERE id = p_transfer_id;

  RETURN jsonb_build_object('reference', v_ref, 'feeKobo', v_transfer.fee_kobo);
END;
$function$;

-- ── 5. owner lookup: any attempt ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_transfer_fee_payment_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- [0239] Resolved through the attempt, so every attempt the recipient made
  -- can be verified, not only the newest.
  SELECT COALESCE(
    (SELECT t.to_user_id FROM public.ticket_transfer_fee_attempts a
       JOIN public.ticket_transfers t ON t.id = a.transfer_id
      WHERE a.reference = p_reference),
    (SELECT to_user_id FROM public.ticket_transfers WHERE fee_payment_ref = p_reference));
$function$;

-- ── 6. confirm: the live rules, with every outcome recorded ──────────────────
-- Internal: record this reference's outcome and first answer, exactly once.
CREATE FUNCTION public.ticket_transfer_fee_attempt_outcome(
  p_reference text, p_transfer_id uuid, p_fee_kobo bigint, p_payer uuid, p_outcome text, p_paid_kobo bigint, p_answer text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.ticket_transfer_fee_attempts (reference, transfer_id, fee_kobo, payer_id, outcome, paid_kobo, outcome_at, answer)
  VALUES (p_reference, p_transfer_id, p_fee_kobo, p_payer, p_outcome, p_paid_kobo, now(), p_answer)
  ON CONFLICT (reference) DO UPDATE
     SET outcome = EXCLUDED.outcome, paid_kobo = EXCLUDED.paid_kobo, outcome_at = EXCLUDED.outcome_at, answer = EXCLUDED.answer
   WHERE public.ticket_transfer_fee_attempts.outcome IS NULL;
  RETURN p_answer;
END;
$function$;
REVOKE ALL ON FUNCTION public.ticket_transfer_fee_attempt_outcome(text, uuid, bigint, uuid, text, bigint, text) FROM PUBLIC, anon, authenticated, project_admin;

CREATE OR REPLACE FUNCTION public.confirm_transfer_fee_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_transfer    record;
  v_ticket      record;
  v_attempt     record;
  v_full_name   text;
  v_email       text;
  v_phone       text;
  v_rows        int;
  v_transfer_id uuid;
  v_closed      text;   -- why a paid fee could not complete the transfer
  v_answer      text;
BEGIN
  -- [0239] Resolve the transfer through the attempt (any attempt, old or new).
  SELECT a.transfer_id INTO v_transfer_id FROM public.ticket_transfer_fee_attempts a WHERE a.reference = p_reference;
  IF v_transfer_id IS NULL THEN
    SELECT t.id INTO v_transfer_id FROM public.ticket_transfers t WHERE t.fee_payment_ref = p_reference;
  END IF;
  IF v_transfer_id IS NULL THEN
    -- [0239] A captured transfer-fee payment nobody can match: recorded so it
    -- can be refunded by two admins instead of disappearing.
    IF p_reference LIKE 'txf\_%' THEN
      PERFORM public.record_transfer_fee_payment_exception(p_reference, NULL, 'not_found', p_amount_kobo, NULL,
        'No ticket transfer matches this transfer-fee reference');
      RETURN 'not_found:refund_queued';
    END IF;
    RETURN 'not_found';
  END IF;

  -- The transfer row lock serializes every payment for this transfer
  -- (webhook and verify, retries, two different references).
  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE id = v_transfer_id FOR UPDATE;
  SELECT a.outcome, a.answer INTO v_attempt FROM public.ticket_transfer_fee_attempts a WHERE a.reference = p_reference;

  -- [0239] A replay of a reference that already has an outcome: the first
  -- answer, unchanged (its record, if any, already exists; nothing moves).
  IF v_attempt.outcome IS NOT NULL THEN
    RETURN CASE v_attempt.outcome
             WHEN 'paid' THEN 'already_paid'
             WHEN 'overpaid' THEN 'already_paid:excess_refund_queued'
             ELSE v_attempt.answer END;
  END IF;

  -- Live 0043 rule: the transfer was already paid (by ANOTHER reference) or
  -- already closed after a payment -> this is a second payment.
  IF v_transfer.fee_paid_at IS NOT NULL OR v_transfer.fee_refund_needed_at IS NOT NULL THEN
    PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'duplicate_payment', p_amount_kobo,
      v_transfer.fee_kobo, 'This transfer was already paid by reference ' || COALESCE(v_transfer.fee_payment_ref, '?'));
    RETURN public.ticket_transfer_fee_attempt_outcome(p_reference, v_transfer.id, v_transfer.fee_kobo, v_transfer.to_user_id,
      'duplicate', p_amount_kobo, 'duplicate_payment:refund_queued');
  END IF;

  -- Live 0043 order: not pending, then expired, then the amount, then the
  -- ticket. A paid fee that cannot complete the transfer is a late payment.
  IF v_transfer.status <> 'pending' THEN
    v_closed := 'transfer_not_pending:' || v_transfer.status;
  ELSIF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = v_transfer.id;
    v_closed := 'expired';
  ELSE
    -- Live rule (owner: keep): any amount at or above the fee completes the
    -- transfer. Less, or no amount at all, changes nothing on the transfer.
    IF p_amount_kobo IS NULL OR p_amount_kobo < v_transfer.fee_kobo THEN
      PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'amount_mismatch', p_amount_kobo,
        v_transfer.fee_kobo, 'Paid less than the transfer fee (paid ' || COALESCE(p_amount_kobo::text, 'no amount') || ' kobo)');
      RETURN public.ticket_transfer_fee_attempt_outcome(p_reference, v_transfer.id, v_transfer.fee_kobo, v_transfer.to_user_id,
        'underpaid', p_amount_kobo,
        'amount_mismatch:' || v_transfer.fee_kobo::text || ':' || COALESCE(p_amount_kobo::text, 'null') || ':refund_queued');
    END IF;

    SELECT t.user_id, t.status, t.checked_in
      INTO v_ticket
      FROM public.tickets t
     WHERE t.id = v_transfer.ticket_id
     FOR UPDATE;

    IF v_ticket.user_id IS DISTINCT FROM v_transfer.from_user_id
       OR v_ticket.status <> 'active' OR v_ticket.checked_in THEN
      UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = v_transfer.id;
      v_closed := 'ticket_ineligible';
    ELSE
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
        v_closed := 'ticket_ineligible';
      END IF;
    END IF;
  END IF;

  -- [0239] This reference is the payment that landed on this transfer; the
  -- transfer keeps pointing at the reference that actually paid.
  IF v_transfer.fee_payment_ref IS DISTINCT FROM p_reference THEN
    UPDATE public.ticket_transfers SET fee_payment_ref = p_reference WHERE id = v_transfer.id;
  END IF;

  IF v_closed IS NOT NULL THEN
    -- [0239] Late payment: owed back in full, through two admins (0234).
    UPDATE public.ticket_transfers
       SET fee_refund_needed_at = now(), fee_refund_status = 'awaiting_approval'
     WHERE id = v_transfer.id;
    PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'transfer_not_completed',
      p_amount_kobo, v_transfer.fee_kobo, 'The ticket transfer could not complete after the fee was paid (' || v_closed || ')');
    RETURN public.ticket_transfer_fee_attempt_outcome(p_reference, v_transfer.id, v_transfer.fee_kobo, v_transfer.to_user_id,
      'late', p_amount_kobo, v_closed || ':refund_queued');
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

  -- [0239] The `<` rule keeps the transfer; the excess is never kept silently.
  IF p_amount_kobo > v_transfer.fee_kobo THEN
    PERFORM public.record_transfer_fee_payment_exception(p_reference, v_transfer.id, 'overpayment',
      p_amount_kobo - v_transfer.fee_kobo, v_transfer.fee_kobo,
      'Paid ' || p_amount_kobo::text || ' kobo for a ' || v_transfer.fee_kobo::text || ' kobo fee; only the excess is refundable');
    RETURN public.ticket_transfer_fee_attempt_outcome(p_reference, v_transfer.id, v_transfer.fee_kobo, v_transfer.to_user_id,
      'overpaid', p_amount_kobo, 'confirmed:excess_refund_queued');
  END IF;

  RETURN public.ticket_transfer_fee_attempt_outcome(p_reference, v_transfer.id, v_transfer.fee_kobo, v_transfer.to_user_id,
    'paid', p_amount_kobo, 'confirmed');
END;
$function$;

COMMIT;
