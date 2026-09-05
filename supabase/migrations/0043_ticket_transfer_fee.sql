-- Stage: Ticket Transfer monetization.
--
-- Audit of 0040_ticket_transfer.sql confirmed the ownership-transfer
-- lifecycle itself is already correct and is NOT touched here beyond the
-- one necessary guard in accept_ticket_transfer below:
--   - initiate_ticket_transfer never touches tickets.user_id (sender keeps
--     the ticket while pending) -- unchanged.
--   - accept_ticket_transfer atomically re-validates eligibility and flips
--     tickets.user_id under FOR UPDATE locks on both the transfer row and
--     the ticket row -- unchanged except for the new fee gate.
--   - decline_ticket_transfer/cancel_ticket_transfer never touch
--     tickets.user_id -- unchanged.
--   - ticket_transfers_one_pending_per_ticket (unique partial index) +
--     the FOR UPDATE locks already make a double-accept/duplicate-pending
--     transfer structurally impossible -- unchanged.
--   - generate_ticket_token requires auth.uid() = the ticket's LIVE
--     user_id, and verify_entry_pass rejects any token whose payload
--     purchaserId no longer matches the live owner (payload_mismatch) --
--     both already correct, unchanged. A token minted by the old owner
--     stops scanning the instant ownership changes; the new owner mints
--     a fresh one (existing behavior).
--
-- What's new: a recipient-paid transfer fee (7.5% of the ticket's own
-- amount, clamped 500-5000 NGN), verified through the EXACT same
-- Paystack-verify architecture confirm_ticket_payment already uses
-- (api/webhook/paystack.ts's ?action=verify path + its authoritative
-- webhook, both funneling into project_admin-only RPCs) -- no second
-- payment system, no new serverless function (Vercel Hobby's 12-function
-- cap is already exactly hit per that file's own header comment).
--
-- Design: the fee is computed and locked in at initiate time (from the
-- ticket's own `amount` at that moment -- authoritative, never a
-- client-supplied number). Accepting a transfer with a fee now requires
-- confirm_transfer_fee_payment to have run first (project_admin-only,
-- same trust boundary as confirm_ticket_payment) -- accept_ticket_transfer
-- itself now refuses to run the ownership swap until fee_paid_at is set.
-- confirm_transfer_fee_payment performs the ownership swap itself,
-- atomically with marking the fee paid, so there is never a window where
-- the fee is paid but ownership hasn't moved (or vice versa).

ALTER TABLE public.ticket_transfers
  ADD COLUMN IF NOT EXISTS fee_kobo bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_payment_ref text,
  ADD COLUMN IF NOT EXISTS fee_paid_at timestamptz;

-- Unambiguous lookup for the verify path (confirm_transfer_fee_payment
-- looks a transfer up by this reference) -- partial so multiple rows can
-- share NULL (no payment attempt started yet) without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_transfers_fee_payment_ref_idx
  ON public.ticket_transfers (fee_payment_ref) WHERE (fee_payment_ref IS NOT NULL);

-- ---------------------------------------------------------------------
-- compute_transfer_fee_kobo: pure helper, no table access -- 7.5% of the
-- ticket's own amount (Naira, per tickets.amount), converted to kobo and
-- clamped to [50000, 500000] kobo (NGN 500-5000). Never given a client-
-- supplied ticket price; every caller below passes tickets.amount read
-- straight from the row itself.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_transfer_fee_kobo(p_ticket_amount numeric)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT GREATEST(50000, LEAST(500000, ROUND(COALESCE(p_ticket_amount, 0) * 100 * 0.075)))::bigint;
$function$
;

REVOKE ALL ON FUNCTION public.compute_transfer_fee_kobo(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_transfer_fee_kobo(numeric) TO authenticated, project_admin;

-- ---------------------------------------------------------------------
-- initiate_ticket_transfer: unchanged eligibility/ownership logic: now
-- also reads the ticket's amount and locks in fee_kobo on the new row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.initiate_ticket_transfer(p_ticket_id uuid, p_recipient_identifier text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_ticket       record;
  v_identifier   text := lower(trim(COALESCE(p_recipient_identifier, '')));
  v_recipient_id uuid;
  v_transfer_id  uuid;
  v_fee_kobo     bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_identifier = '' THEN RAISE EXCEPTION 'A recipient email or username is required'; END IF;

  PERFORM public.check_rate_limit('ticket_transfer_init:' || v_uid::text, 10, 3600);

  SELECT t.id, t.user_id, t.status, t.payment_status, t.checked_in, t.amount, e.event_date
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF v_ticket.id IS NULL THEN RAISE EXCEPTION 'Ticket not found'; END IF;
  IF v_ticket.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the current ticket owner can start a transfer';
  END IF;
  IF v_ticket.payment_status <> 'paid' THEN RAISE EXCEPTION 'Only paid tickets can be transferred'; END IF;
  IF v_ticket.status <> 'active' THEN RAISE EXCEPTION 'This ticket is not active'; END IF;
  IF v_ticket.checked_in THEN RAISE EXCEPTION 'A ticket already checked in cannot be transferred'; END IF;
  IF v_ticket.event_date IS NOT NULL AND v_ticket.event_date < now() THEN
    RAISE EXCEPTION 'This event has already started -- the ticket can no longer be transferred';
  END IF;

  SELECT id INTO v_recipient_id FROM public.users
   WHERE (lower(email) = v_identifier OR lower(username) = v_identifier)
     AND deleted_at IS NULL
   LIMIT 1;

  IF v_recipient_id IS NULL THEN RAISE EXCEPTION 'No VENTS account found for that email or username'; END IF;
  IF v_recipient_id = v_uid THEN RAISE EXCEPTION 'You cannot transfer a ticket to yourself'; END IF;

  -- Lazily expire a stale pending transfer for this ticket rather than
  -- requiring a cron job -- the unique index only excludes live 'pending'
  -- rows, so a transfer whose 48h window has lapsed must be flipped before
  -- a new one can be created.
  UPDATE public.ticket_transfers
     SET status = 'expired'
   WHERE ticket_id = p_ticket_id AND status = 'pending' AND expires_at < now();

  IF EXISTS (SELECT 1 FROM public.ticket_transfers WHERE ticket_id = p_ticket_id AND status = 'pending') THEN
    RAISE EXCEPTION 'This ticket already has a pending transfer';
  END IF;

  v_fee_kobo := public.compute_transfer_fee_kobo(v_ticket.amount);

  INSERT INTO public.ticket_transfers (ticket_id, from_user_id, to_user_id, to_identifier, status, expires_at, fee_kobo)
  VALUES (p_ticket_id, v_uid, v_recipient_id, v_identifier, 'pending', now() + interval '48 hours', v_fee_kobo)
  RETURNING id INTO v_transfer_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_recipient_id, 'event_update', 'Ticket transfer request',
    'Someone wants to transfer a ticket to you. Review it in My Tickets.',
    false, '🎟️', jsonb_build_object('transferId', v_transfer_id, 'ticketId', p_ticket_id)
  );

  RETURN v_transfer_id;
END;
$function$
;

-- ---------------------------------------------------------------------
-- initiate_transfer_fee_payment: recipient-only. Generates a fresh
-- reference for this payment attempt (safe to call again after an
-- abandoned/failed popup -- overwrites fee_payment_ref, so only the
-- latest reference can ever confirm this transfer). Returns the exact
-- amount to charge -- the client shows and pays this, never a
-- client-computed number.
-- ---------------------------------------------------------------------
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
$function$
;

REVOKE ALL ON FUNCTION public.initiate_transfer_fee_payment(uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.initiate_transfer_fee_payment(uuid) TO authenticated, project_admin;

-- ---------------------------------------------------------------------
-- get_transfer_fee_payment_owner: same pattern as get_pending_purchase_owner
-- (0031_restrict_finalize_pending_purchase.sql) -- ticket_transfers has RLS
-- with only an involved-party SELECT policy, so api/webhook/paystack.ts
-- (running over the project_admin connection, no user JWT/RLS context of
-- its own) needs this to confirm the authenticated caller who hit that
-- endpoint is actually the recipient of the reference they're asking to
-- verify, before ever calling Paystack's verify API on their say-so.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_transfer_fee_payment_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT to_user_id FROM public.ticket_transfers WHERE fee_payment_ref = p_reference;
$function$;

REVOKE ALL ON FUNCTION public.get_transfer_fee_payment_owner(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_transfer_fee_payment_owner(text) TO project_admin;

-- ---------------------------------------------------------------------
-- confirm_transfer_fee_payment: project_admin-only, called exclusively
-- from api/webhook/paystack.ts after Paystack's own GET /transaction/
-- verify/:reference confirms status='success' -- the exact same trust
-- boundary confirm_ticket_payment already uses. Never trusts the amount
-- it's given as authorization on its own: compares it to fee_kobo (locked
-- in at initiate time from the ticket's own amount) and refuses to
-- proceed on any mismatch. Performs the ownership swap itself, atomically
-- with marking the fee paid, so payment and ownership transfer can never
-- become inconsistent with each other.
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
BEGIN
  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE fee_payment_ref = p_reference FOR UPDATE;
  IF v_transfer.id IS NULL THEN RETURN 'not_found'; END IF;

  -- Idempotent: a retried webhook/verify call for an already-confirmed
  -- transfer is a no-op, not an error -- same convention as
  -- confirm_ticket_payment's own 'already_paid' branch.
  IF v_transfer.fee_paid_at IS NOT NULL THEN RETURN 'already_paid'; END IF;

  IF v_transfer.status <> 'pending' THEN
    RETURN 'transfer_not_pending:' || v_transfer.status;
  END IF;

  IF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = v_transfer.id;
    RETURN 'expired';
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
$function$
;

REVOKE ALL ON FUNCTION public.confirm_transfer_fee_payment(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_transfer_fee_payment(text, bigint) TO project_admin;

-- ---------------------------------------------------------------------
-- accept_ticket_transfer: the free-accept path now only exists for a
-- transfer somehow carrying no fee (fee_kobo <= 0 -- not reachable via
-- initiate_ticket_transfer above, which always computes a >= 50000 kobo
-- fee, but guarded rather than assumed). Every real transfer now requires
-- confirm_transfer_fee_payment (via the paid flow) to have run first.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_ticket_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_transfer  record;
  v_ticket    record;
  v_full_name text;
  v_email     text;
  v_phone     text;
  v_rows      int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_transfer.to_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the intended recipient can accept this transfer';
  END IF;

  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending (status: %)', v_transfer.status;
  END IF;

  IF v_transfer.expires_at < now() THEN
    UPDATE public.ticket_transfers SET status = 'expired' WHERE id = p_transfer_id;
    RAISE EXCEPTION 'This transfer request has expired';
  END IF;

  -- A transfer fee must be paid (confirm_transfer_fee_payment) before this
  -- free path may run the ownership swap -- see this function's own header
  -- comment. fee_kobo is always > 0 for every transfer created by
  -- initiate_ticket_transfer, so this branch is the actual gate in
  -- practice, not just documentation.
  IF v_transfer.fee_kobo > 0 AND v_transfer.fee_paid_at IS NULL THEN
    RAISE EXCEPTION 'A transfer fee must be paid before this transfer can be accepted';
  END IF;

  SELECT t.user_id, t.status, t.checked_in
    INTO v_ticket
    FROM public.tickets t
   WHERE t.id = v_transfer.ticket_id
   FOR UPDATE;

  IF v_ticket.user_id IS DISTINCT FROM v_transfer.from_user_id
     OR v_ticket.status <> 'active' OR v_ticket.checked_in THEN
    UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = p_transfer_id;
    RAISE EXCEPTION 'This ticket is no longer eligible for transfer';
  END IF;

  SELECT full_name, email, phone_number INTO v_full_name, v_email, v_phone
    FROM public.users WHERE id = v_uid;

  UPDATE public.tickets
     SET user_id = v_uid,
         holder_name = COALESCE(v_full_name, holder_name),
         holder_email = COALESCE(v_email, holder_email),
         holder_phone = COALESCE(v_phone, holder_phone)
   WHERE id = v_transfer.ticket_id
     AND user_id = v_transfer.from_user_id
     AND checked_in = false;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'This ticket is no longer eligible for transfer';
  END IF;

  UPDATE public.ticket_transfers SET status = 'accepted', responded_at = now() WHERE id = p_transfer_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_transfer.from_user_id, 'event_update', 'Ticket transfer accepted',
    'Your ticket transfer was accepted.', false, '✅',
    jsonb_build_object('transferId', p_transfer_id, 'ticketId', v_transfer.ticket_id)
  );
END;
$function$
;
