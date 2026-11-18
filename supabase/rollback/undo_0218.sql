-- Undo 0218 only (supabase/migrations/0218_event_cancellation_workflow.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0218';
--   \i supabase/rollback/undo_0218.sql
-- Refused once any cancellation request exists: the requests, refund rows and
-- the events' cancellation stamps are the record attendees' refunds rest on.
-- Changes no ticket, wallet, ledger or event row.
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0218' THEN
    RAISE EXCEPTION 'undo_0218 refused: set vents.rollback_confirm = ''undo-0218'' to confirm';
  END IF;
  IF to_regclass('public.event_cancellation_requests') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.event_cancellation_requests) THEN
    RAISE EXCEPTION 'undo_0218 refused: event cancellation requests exist (their history must be kept)';
  END IF;
END
$undo$;

DROP TRIGGER IF EXISTS event_cancellation_ticket_sync ON public.tickets;
DROP TRIGGER IF EXISTS events_cancellation_guard ON public.events;
DROP FUNCTION IF EXISTS public.admin_record_event_cancellation_refund_error(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.admin_claim_event_cancellation_refunds(uuid, integer);
DROP FUNCTION IF EXISTS public.admin_decide_event_cancellation(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.admin_get_event_cancellation(uuid);
DROP FUNCTION IF EXISTS public.admin_list_event_cancellations(text);
DROP FUNCTION IF EXISTS public.get_my_cancellation_refunds();
DROP FUNCTION IF EXISTS public.get_my_event_cancellations();
DROP FUNCTION IF EXISTS public.request_event_cancellation(uuid, text);
DROP FUNCTION IF EXISTS public.event_cancellation_ticket_sync();
DROP FUNCTION IF EXISTS public.events_cancellation_guard();
DROP FUNCTION IF EXISTS public.event_cancellation_enqueue(uuid);
DROP FUNCTION IF EXISTS public.event_cancellation_refresh(uuid);
DROP FUNCTION IF EXISTS public.event_cancellation_refund_method(text, numeric, bigint);
DROP FUNCTION IF EXISTS public.event_ticket_obligations(uuid);
ALTER TABLE public.events DROP COLUMN IF EXISTS cancellation_request_id;
ALTER TABLE public.events DROP COLUMN IF EXISTS cancelled_at;
DROP TABLE IF EXISTS public.event_cancellation_refunds;
DROP TABLE IF EXISTS public.event_cancellation_requests;
