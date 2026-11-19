-- 0219: event cancellation safety fixes (pre-release review of 0218).
--
-- Each fix closes a defect found in review; none changes a refund amount, a
-- fee, the organizer deduction, a settlement rule, a wallet or a payout.
--
--   1. No check-in at a cancelled event. Before this, the organizer, who is
--      the party debited for refunds, or their door staff could check in the
--      tickets of a cancelled event (manual_check_in / verify_entry_pass check
--      only the ticket's own status). refund_ticket refuses a checked-in
--      ticket, so this blocked the attendee's refund. Enforced by a trigger on
--      tickets.checked_in, which covers every check-in path.
--   2. Only a Super Admin can run refunds. The existing refund API releases a
--      refund that Paystack rejects, or that the global ceiling stops, through
--      admin_revert_stuck_refund, which requires a Super Admin. The API calls
--      it with the caller's own session. A sub-admin's run therefore stranded
--      such tickets in refund_pending with no refund id, indistinguishable
--      from a timeout. Claiming now requires is_super_admin(), the same
--      authority that decides the cancellation.
--   3. Stranded retries can be recovered. Every claim spends one of five
--      attempts, including attempts refused before any provider call (the
--      30/hour refund_ticket limit, the 100/hour Paystack ceiling). A large
--      event could therefore leave tickets permanently unclaimable, with no
--      recovery short of SQL. admin_requeue_event_cancellation_refund lets a
--      Super Admin re-queue a failed row, only while the ticket is still
--      'paid' (no refund in flight), with a note and an audit record.
--   4. A ticket checked in by a scan that overlapped the approval (so it was
--      queued as refundable, then refund_ticket refused it as checked in) is
--      recorded as 'blocked' (a manual decision), not retried as 'failed'.
--
-- Requires 0218. One transaction; idempotent. Moves no money and changes no
-- existing row. Rollback: supabase/rollback/undo_0219.sql.

DO $pre$
BEGIN
  IF to_regclass('public.event_cancellation_refunds') IS NULL
     OR to_regprocedure('public.admin_claim_event_cancellation_refunds(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '0219 requires 0218 (event cancellation workflow is missing)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. No check-in at a cancelled event
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tickets_cancelled_event_checkin_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.checked_in AND NOT COALESCE(OLD.checked_in, false)
     AND EXISTS (SELECT 1 FROM public.events e WHERE e.id = NEW.event_id AND e.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This event was cancelled; its tickets cannot be checked in';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS tickets_cancelled_event_checkin_guard ON public.tickets;
CREATE TRIGGER tickets_cancelled_event_checkin_guard BEFORE UPDATE OF checked_in ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.tickets_cancelled_event_checkin_guard();

-- ---------------------------------------------------------------------------
-- 2. Claiming refunds: Super Admin only. (Body otherwise identical to 0218's.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_claim_event_cancellation_refunds(p_request_id uuid, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.event_cancellation_requests;
  v_tickets jsonb;
BEGIN
  -- [0219] The refund API's release path (admin_revert_stuck_refund) needs a
  -- Super Admin; a sub-admin's run would strand Paystack rejections.
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required to process refunds'; END IF;
  SELECT * INTO r FROM public.event_cancellation_requests WHERE id = p_request_id;
  IF NOT FOUND OR r.status NOT IN ('processing', 'attention') THEN
    RAISE EXCEPTION 'Refunds can only be processed for an approved cancellation (status: %)', COALESCE(r.status, 'not found');
  END IF;
  PERFORM public.event_cancellation_enqueue(p_request_id);

  WITH c AS (
    SELECT x.id FROM public.event_cancellation_refunds x
      JOIN public.tickets t ON t.id = x.ticket_id
     WHERE x.request_id = p_request_id AND t.payment_status = 'paid' AND x.attempts < 5
       AND (x.status IN ('queued', 'failed') OR (x.status = 'processing' AND x.claimed_at < now() - interval '15 minutes'))
     ORDER BY x.attempts, x.created_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 25)
     FOR UPDATE OF x SKIP LOCKED),
  u AS (
    UPDATE public.event_cancellation_refunds x
       SET status = 'processing', claimed_at = now(), attempts = x.attempts + 1, updated_at = now()
      FROM c WHERE x.id = c.id
    RETURNING x.ticket_id, x.payment_method, x.amount_kobo, x.attempts, x.created_at)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ticket_id', u.ticket_id, 'payment_method', u.payment_method,
                                               'amount_kobo', u.amount_kobo, 'attempt', u.attempts) ORDER BY u.created_at), '[]'::jsonb)
    INTO v_tickets FROM u;

  PERFORM public.event_cancellation_refresh(p_request_id);
  RETURN jsonb_build_object('reason', 'Event cancelled: ' || r.reason, 'tickets', v_tickets);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. A failed attempt on a ticket checked in meanwhile is 'blocked'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_record_event_cancellation_refund_error(p_request_id uuid, p_ticket_id uuid, p_error text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  UPDATE public.event_cancellation_refunds x
     SET status = CASE WHEN t.checked_in THEN 'blocked' ELSE 'failed' END,
         last_error = CASE WHEN t.checked_in THEN 'The ticket was checked in; refund it manually if appropriate'
                           ELSE left(COALESCE(NULLIF(btrim(p_error), ''), 'Refund attempt failed'), 500) END,
         updated_at = now()
    FROM public.tickets t
   WHERE x.request_id = p_request_id AND x.ticket_id = p_ticket_id AND t.id = x.ticket_id
     AND t.payment_status = 'paid' AND x.status IN ('processing', 'queued', 'failed')
  RETURNING x.status INTO v_status;
  PERFORM public.event_cancellation_refresh(p_request_id);
  RETURN COALESCE(v_status, 'unchanged');
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Re-queue a failed refund (Super Admin, audited). Only while the ticket
--    is still 'paid': no refund is in flight for it, and refund_ticket keeps
--    refusing a second refund in any case.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_requeue_event_cancellation_refund(p_request_id uuid, p_ticket_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  r public.event_cancellation_requests;
  x public.event_cancellation_refunds;
  v_pay text;
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 5 THEN RAISE EXCEPTION 'A note of at least 5 characters is required to re-queue a refund'; END IF;
  SELECT * INTO r FROM public.event_cancellation_requests WHERE id = p_request_id;
  IF NOT FOUND OR r.status NOT IN ('processing', 'attention') THEN
    RAISE EXCEPTION 'Only refunds of an approved, unfinished cancellation can be re-queued';
  END IF;
  SELECT * INTO x FROM public.event_cancellation_refunds WHERE request_id = p_request_id AND ticket_id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This ticket has no refund in this cancellation'; END IF;
  SELECT payment_status INTO v_pay FROM public.tickets WHERE id = p_ticket_id FOR UPDATE;
  IF x.status <> 'failed' THEN
    RAISE EXCEPTION 'Only a failed refund can be re-queued (status: %)', x.status;
  END IF;
  IF v_pay IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'The ticket is %, not paid: a refund may be in flight; check it in Paystack first', v_pay;
  END IF;

  UPDATE public.event_cancellation_refunds
     SET status = 'queued', attempts = 0, claimed_at = NULL, updated_at = now()
   WHERE id = x.id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_uid, 'event_cancellation_refund_requeued', x.user_id,
          jsonb_build_object('cancellation_id', p_request_id, 'ticket_id', p_ticket_id, 'previous_attempts', x.attempts,
                             'previous_error', x.last_error, 'note', btrim(p_note)), public.actor_role());
  PERFORM public.event_cancellation_refresh(p_request_id);
  RETURN jsonb_build_object('ticket_id', p_ticket_id, 'status', 'queued', 'previous_attempts', x.attempts);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.tickets_cancelled_event_checkin_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_claim_event_cancellation_refunds(uuid, integer),
  public.admin_record_event_cancellation_refund_error(uuid, uuid, text),
  public.admin_requeue_event_cancellation_refund(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_claim_event_cancellation_refunds(uuid, integer),
  public.admin_record_event_cancellation_refund_error(uuid, uuid, text),
  public.admin_requeue_event_cancellation_refund(uuid, uuid, text) TO authenticated;
