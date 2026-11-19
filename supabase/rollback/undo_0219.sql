-- Undo 0219 only (supabase/migrations/0219_event_cancellation_safety_fixes.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0219';
--   \i supabase/rollback/undo_0219.sql
-- Restores 0218's exact bodies of the two functions 0219 replaced, and drops
-- the check-in guard and the re-queue function. Changes no ticket, refund row,
-- wallet, ledger or event row (re-queues already made stay in admin_logs).
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0219' THEN
    RAISE EXCEPTION 'undo_0219 refused: set vents.rollback_confirm = ''undo-0219'' to confirm';
  END IF;
END
$undo$;

DROP TRIGGER IF EXISTS tickets_cancelled_event_checkin_guard ON public.tickets;
DROP FUNCTION IF EXISTS public.tickets_cancelled_event_checkin_guard();
DROP FUNCTION IF EXISTS public.admin_requeue_event_cancellation_refund(uuid, uuid, text);

-- 0218's bodies, verbatim.

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
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
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
     SET status = 'failed', last_error = left(COALESCE(NULLIF(btrim(p_error), ''), 'Refund attempt failed'), 500), updated_at = now()
    FROM public.tickets t
   WHERE x.request_id = p_request_id AND x.ticket_id = p_ticket_id AND t.id = x.ticket_id
     AND t.payment_status = 'paid' AND x.status IN ('processing', 'queued', 'failed')
  RETURNING x.status INTO v_status;
  PERFORM public.event_cancellation_refresh(p_request_id);
  RETURN COALESCE(v_status, 'unchanged');
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_claim_event_cancellation_refunds(uuid, integer),
  public.admin_record_event_cancellation_refund_error(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_claim_event_cancellation_refunds(uuid, integer),
  public.admin_record_event_cancellation_refund_error(uuid, uuid, text) TO authenticated;
