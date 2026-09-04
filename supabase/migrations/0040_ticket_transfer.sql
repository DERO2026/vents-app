-- Stage 9: Ticket Transfer.
--
-- Audit confirmed this is greenfield -- no transfer table/RPC/UI exists
-- anywhere. tickets.user_id is the sole ownership pointer (one row per
-- attendee, quantity always 1); tickets.status is CHECK-constrained to
-- exactly 'active'/'cancelled' (no 'transferred'/'used' value, and this
-- migration does not add one, per instruction); checked_in is a separate
-- boolean from status. The signed QR/token architecture
-- (generate_ticket_token / verify_entry_pass, both untouched here) already
-- re-checks payload.purchaserId against the ticket's LIVE user_id at scan
-- time -- so a token minted before a transfer is automatically rejected
-- (payload_mismatch) with no changes needed to either function; the new
-- owner just mints a fresh token (existing RPC, already keyed off
-- auth.uid() = tickets.user_id).
--
-- RLS gap found and closed: update_tickets' WITH CHECK lets an event's
-- organizer rewrite ANY ticket's user_id to anyone today, with no
-- business-logic gate at all (unlike a regular owner, who already can't --
-- WITH CHECK requires new user_id = auth.uid() for them). Closed below via
-- a trigger matching the codebase's existing protect_*_columns idiom
-- (see protect_event_promotion_columns, 0004_functions.sql:3530): it
-- short-circuits when current_user <> 'authenticated', which is exactly
-- how those existing triggers let SECURITY DEFINER functions (which run
-- as the function owner, not the 'authenticated' role) through while still
-- blocking direct client UPDATEs -- no new flag/GUC plumbing needed, this
-- is the same mechanism already proven elsewhere in this schema.

-- ---------------------------------------------------------------------
-- Table: ticket_transfers -- append-only per request; each row IS the
-- permanent historical record once resolved (accepted/declined/cancelled/
-- expired rows are never deleted or overwritten past their terminal
-- state), same idiom as organizer_transactions.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_transfers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id),
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  to_identifier text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (id)
);

ALTER TABLE ticket_transfers ADD CONSTRAINT ticket_transfers_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'cancelled'::text, 'expired'::text]));

ALTER TABLE ticket_transfers ADD CONSTRAINT ticket_transfers_not_self_check
  CHECK (from_user_id <> to_user_id);

-- Structurally impossible to have two live pending transfers for the same
-- ticket -- this, plus the atomic guarded UPDATE in accept_ticket_transfer
-- below, is what makes "two active owners" impossible even under a race.
CREATE UNIQUE INDEX ticket_transfers_one_pending_per_ticket
  ON ticket_transfers (ticket_id) WHERE (status = 'pending');

CREATE INDEX ticket_transfers_ticket_id_idx ON ticket_transfers (ticket_id);
CREATE INDEX ticket_transfers_from_user_idx ON ticket_transfers (from_user_id);
CREATE INDEX ticket_transfers_to_user_idx ON ticket_transfers (to_user_id);

ALTER TABLE ticket_transfers ENABLE ROW LEVEL SECURITY;

-- Both parties can read a transfer they're involved in; nobody else can.
-- All writes go through the SECURITY DEFINER functions below (matching
-- organizer_transactions' admin-only-by-policy / function-owner-bypass
-- pattern) -- no direct client INSERT/UPDATE policy exists at all, so RLS
-- alone blocks any attempt to fabricate or rewrite a transfer row.
CREATE POLICY ticket_transfers_involved_read ON ticket_transfers FOR SELECT TO authenticated
  USING (from_user_id = (SELECT auth.uid()) OR to_user_id = (SELECT auth.uid()));

-- Table-level grants, matching this schema's established convention (every
-- other table -- organizer_transactions, organizer_withdrawal_requests,
-- service_providers, etc. -- grants broad DML at this level and relies on
-- RLS, not table privileges, as the actual enforcement boundary). Since no
-- INSERT/UPDATE/DELETE policy exists for anon/authenticated above, RLS
-- still blocks all direct client writes -- only the SECURITY DEFINER
-- functions above (which bypass RLS as the table owner) can write.
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ticket_transfers TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ticket_transfers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ticket_transfers TO project_admin;

-- ---------------------------------------------------------------------
-- Trigger: close the organizer-can-rewrite-user_id RLS gap.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_ticket_ownership_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- SECURITY DEFINER functions (accept_ticket_transfer, and every existing
  -- ticket-mutating RPC) run as the function owner, not as 'authenticated'
  -- -- same short-circuit already used by protect_event_promotion_columns/
  -- protect_admin_tier_status_columns/protect_trust_signal_columns.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'tickets.user_id can only be changed via accept_ticket_transfer()';
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE TRIGGER trg_protect_ticket_ownership_column BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION protect_ticket_ownership_column();

-- ---------------------------------------------------------------------
-- initiate_ticket_transfer: only the current owner, on an eligible ticket,
-- to an existing different VENTS user, one pending transfer at a time.
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
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_identifier = '' THEN RAISE EXCEPTION 'A recipient email or username is required'; END IF;

  PERFORM public.check_rate_limit('ticket_transfer_init:' || v_uid::text, 10, 3600);

  SELECT t.id, t.user_id, t.status, t.payment_status, t.checked_in, e.event_date
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

  INSERT INTO public.ticket_transfers (ticket_id, from_user_id, to_user_id, to_identifier, status, expires_at)
  VALUES (p_ticket_id, v_uid, v_recipient_id, v_identifier, 'pending', now() + interval '48 hours')
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
-- accept_ticket_transfer: only the intended recipient; re-validates the
-- ticket is still eligible (it may have been checked in, refunded, or the
-- event may have started during the pending window); atomically guarded
-- so a race against a concurrent accept/cancel/decline can never produce
-- two owners or a double-accept.
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

-- ---------------------------------------------------------------------
-- decline_ticket_transfer: only the intended recipient, while pending.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_ticket_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_transfer record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_transfer.to_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the intended recipient can decline this transfer';
  END IF;
  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending (status: %)', v_transfer.status;
  END IF;

  UPDATE public.ticket_transfers SET status = 'declined', responded_at = now() WHERE id = p_transfer_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_transfer.from_user_id, 'event_update', 'Ticket transfer declined',
    'Your ticket transfer request was declined.', false, '❌',
    jsonb_build_object('transferId', p_transfer_id, 'ticketId', v_transfer.ticket_id)
  );
END;
$function$
;

-- ---------------------------------------------------------------------
-- cancel_ticket_transfer: only the sender, while pending.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_ticket_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_transfer record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_transfer FROM public.ticket_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_transfer.from_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the sender can cancel this transfer';
  END IF;
  IF v_transfer.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending (status: %)', v_transfer.status;
  END IF;

  UPDATE public.ticket_transfers SET status = 'cancelled', responded_at = now() WHERE id = p_transfer_id;
END;
$function$
;

-- No notifications.type CHECK widening needed -- all three notifications
-- above reuse the existing 'event_update' type.

REVOKE ALL ON FUNCTION public.initiate_ticket_transfer(uuid, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.initiate_ticket_transfer(uuid, text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.accept_ticket_transfer(uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.accept_ticket_transfer(uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.decline_ticket_transfer(uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.decline_ticket_transfer(uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.cancel_ticket_transfer(uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.cancel_ticket_transfer(uuid) TO authenticated, project_admin;
