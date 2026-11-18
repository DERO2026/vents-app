-- 0218: event cancellation with refunds and attendee protection (Batch 2).
--
-- The defect: an organizer could soft-delete an event with paid tickets
-- (soft_delete_event, or a direct UPDATE of events.deleted_at, which the
-- events RLS policy allows for the owner). No refund started, no attendee was
-- told, and select_events then hid the event from its ticket holders.
--
-- This migration:
--   1. Guards events (trigger events_cancellation_guard):
--      * an event with ticket obligations (a ticket that is 'paid' or
--        'refund_pending', free RSVPs included, or a pending purchase)
--        cannot be deleted by anyone: cancel it instead;
--      * cancelled_at / cancellation_request_id can only be set by an
--        approved cancellation, never cleared;
--      * a cancelled event can never be made live again or deleted.
--      Hiding an event (status 'draft') is unchanged and is not cancellation.
--      Events without obligations keep their delete/hide behaviour.
--   2. event_cancellation_requests: organizer request -> admin decision
--      -> refund processing. One open request per event.
--      Status: requested | rejected | processing | completed | attention.
--   3. event_cancellation_refunds: one row per affected ticket, tracking the
--      refund to completion. The amount is computed server-side with the
--      same function refund_ticket charges and refunds with.
--   4. Refunds go ONLY through the existing per-ticket path: refund_ticket
--      (wallet: credited at once with its unique ledger row; free: cancelled,
--      no money; Paystack: refund_pending) -> /api/wallet/refund-ticket
--      (Paystack /refund for that ticket's amount, attach_ticket_refund_id)
--      -> the refund.processed / refund.failed webhook (finalize_ticket_refund
--      / fail_ticket_refund). This migration adds no new way to move money:
--      a trigger on tickets mirrors those transitions into the tracking rows.
--   5. Notifications through public.notifications only (no new provider),
--      each sent once.
--
-- Unchanged: fee and refund amounts (refund_ticket's existing policy),
-- organizer deduction, settlement, earnings debits, wallets, VENTS Cents,
-- representative rules, rate limits, the Paystack integration and webhook.
--
-- Moves no money and changes no existing row. Prerequisite: 0208.
-- One transaction; idempotent. Rollback: supabase/rollback/undo_0218.sql.

DO $pre$
BEGIN
  IF to_regprocedure('public.ticket_fee_buyer_charge_kobo(numeric,integer,numeric,text)') IS NULL THEN
    RAISE EXCEPTION '0218 requires 0208 (ticket_fee_buyer_charge_kobo is missing)';
  END IF;
  IF to_regprocedure('public.refund_ticket(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '0218 requires refund_ticket';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_cancellation_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES public.events(id),
  organizer_id   uuid NOT NULL,
  reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  status         text NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'rejected', 'processing', 'completed', 'attention')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  decided_by     uuid,
  decision_note  text,
  snapshot       jsonb,
  completed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_cancellation_decided CHECK (status = 'requested' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT event_cancellation_reject_note CHECK (status <> 'rejected' OR length(btrim(COALESCE(decision_note, ''))) > 0),
  CONSTRAINT event_cancellation_not_self CHECK (decided_by IS NULL OR decided_by <> organizer_id)
);
-- One open (not rejected) request per event: a cancellation happens once.
CREATE UNIQUE INDEX IF NOT EXISTS event_cancellation_requests_one_open
  ON public.event_cancellation_requests (event_id) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS event_cancellation_requests_status ON public.event_cancellation_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.event_cancellation_refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid NOT NULL REFERENCES public.event_cancellation_requests(id),
  ticket_id      uuid NOT NULL UNIQUE REFERENCES public.tickets(id),
  user_id        uuid NOT NULL,
  amount_kobo    bigint NOT NULL CHECK (amount_kobo >= 0),
  payment_method text NOT NULL CHECK (payment_method IN ('paystack', 'wallet', 'free')),
  -- queued: to be refunded; processing: refund started (wallet credit or
  -- Paystack refund in flight); refunded: confirmed by the wallet ledger or
  -- the provider webhook; failed: the attempt failed and can be retried;
  -- blocked: cannot be refunded automatically (a checked-in ticket).
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'processing', 'refunded', 'failed', 'blocked')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text,
  claimed_at     timestamptz,
  refunded_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_cancellation_refund_done CHECK (status <> 'refunded' OR refunded_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS event_cancellation_refunds_request ON public.event_cancellation_refunds (request_id, status);
CREATE INDEX IF NOT EXISTS event_cancellation_refunds_user ON public.event_cancellation_refunds (user_id);

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS cancellation_request_id uuid REFERENCES public.event_cancellation_requests(id);

-- Reads: the organizer of the event, the ticket holder (own rows), admins.
-- No client writes at all: every change goes through the functions below.
ALTER TABLE public.event_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cancellation_refunds  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_cancellation_requests, public.event_cancellation_refunds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_cancellation_requests, public.event_cancellation_refunds TO authenticated;
DROP POLICY IF EXISTS event_cancellation_requests_read ON public.event_cancellation_requests;
CREATE POLICY event_cancellation_requests_read ON public.event_cancellation_requests
  FOR SELECT TO authenticated USING (organizer_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS event_cancellation_refunds_read ON public.event_cancellation_refunds;
CREATE POLICY event_cancellation_refunds_read ON public.event_cancellation_refunds
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR public.is_admin()
    OR EXISTS (SELECT 1 FROM public.event_cancellation_requests r WHERE r.id = request_id AND r.organizer_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Tickets an event still owes its holders something for.
CREATE OR REPLACE FUNCTION public.event_ticket_obligations(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object(
    'paid_tickets',        (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND payment_status = 'paid'),
    'refund_pending',      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND payment_status = 'refund_pending'),
    'pending_purchases',   (SELECT count(*) FROM public.pending_purchases WHERE event_id = p_event_id AND status = 'pending'),
    'ticket_holders',      (SELECT count(DISTINCT user_id) FROM public.tickets WHERE event_id = p_event_id AND payment_status IN ('paid', 'refund_pending')));
$function$;

CREATE OR REPLACE FUNCTION public.event_cancellation_refund_method(p_payment_method text, p_amount numeric, p_charge_kobo bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN COALESCE(p_amount, 0) <= 0 OR COALESCE(p_charge_kobo, 0) <= 0 THEN 'free'
              WHEN p_payment_method = 'wallet' THEN 'wallet'
              ELSE 'paystack' END;
$function$;

-- Recompute a request's status from its tracking rows; notify the organizer
-- once when every refund is done.
CREATE OR REPLACE FUNCTION public.event_cancellation_refresh(p_request_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.event_cancellation_requests;
  v_open integer; v_bad integer; v_status text;
BEGIN
  SELECT * INTO r FROM public.event_cancellation_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status IN ('requested', 'rejected') THEN RETURN r.status; END IF;
  SELECT count(*) FILTER (WHERE status <> 'refunded'), count(*) FILTER (WHERE status IN ('failed', 'blocked'))
    INTO v_open, v_bad FROM public.event_cancellation_refunds WHERE request_id = p_request_id;
  v_status := CASE WHEN v_open = 0 THEN 'completed' WHEN v_bad > 0 THEN 'attention' ELSE 'processing' END;
  IF v_status IS DISTINCT FROM r.status THEN
    UPDATE public.event_cancellation_requests
       SET status = v_status, updated_at = now(),
           completed_at = CASE WHEN v_status = 'completed' THEN now() ELSE NULL END
     WHERE id = p_request_id;
    IF v_status = 'completed' THEN
      INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
      SELECT r.organizer_id, 'event_update', 'Cancellation refunds completed',
             'Every ticket holder of ' || COALESCE(e.title, 'your event') || ' has been refunded.', false, '✅',
             jsonb_build_object('type', 'event_cancellation', 'cancellationId', r.id, 'eventId', r.event_id, 'stage', 'completed')
        FROM public.events e WHERE e.id = r.event_id
         AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.user_id = r.organizer_id
                          AND n.push_data->>'cancellationId' = r.id::text AND n.push_data->>'stage' = 'completed');
    END IF;
  END IF;
  RETURN v_status;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 1. Guard on events
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_cancellation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  o jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'A cancelled event is kept for its ticket holders and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- The cancellation stamp: set once, only by an approved cancellation of this event.
  IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancellation_request_id IS DISTINCT FROM OLD.cancellation_request_id THEN
    IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR NEW.cancellation_request_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.event_cancellation_requests r
                       WHERE r.id = NEW.cancellation_request_id AND r.event_id = NEW.id
                         AND r.status IN ('processing', 'completed', 'attention')) THEN
      RAISE EXCEPTION 'An event is cancelled only through an approved cancellation request';
    END IF;
  END IF;

  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.status = 'live' THEN
      RAISE EXCEPTION 'This event was cancelled; it cannot be put back on sale';
    END IF;
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      RAISE EXCEPTION 'A cancelled event is kept for its ticket holders and cannot be deleted';
    END IF;
  END IF;

  -- Deleting (soft) an event with ticket obligations: cancel it instead.
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    o := public.event_ticket_obligations(NEW.id);
    IF (o->>'paid_tickets')::int + (o->>'refund_pending')::int + (o->>'pending_purchases')::int > 0 THEN
      RAISE EXCEPTION 'This event has % ticket holder(s): request a cancellation instead of deleting it, so they are refunded and told', (o->>'ticket_holders')::int
        USING DETAIL = o::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS events_cancellation_guard ON public.events;
CREATE TRIGGER events_cancellation_guard BEFORE UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_cancellation_guard();

-- ---------------------------------------------------------------------------
-- 2. Organizer request
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_event_cancellation(p_event_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  e public.events;
  v_id uuid;
  o jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.check_rate_limit('event_cancellation_request:' || v_uid::text, 10, 3600);
  SELECT * INTO e FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND OR e.organizer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the organizer of this event can request its cancellation';
  END IF;
  IF e.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This event has been deleted'; END IF;
  IF e.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'This event is already cancelled'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Please give a reason of at least 10 characters; ticket holders will see it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.event_cancellation_requests WHERE event_id = p_event_id AND status <> 'rejected') THEN
    RAISE EXCEPTION 'A cancellation request for this event is already open';
  END IF;

  o := public.event_ticket_obligations(p_event_id);
  INSERT INTO public.event_cancellation_requests (event_id, organizer_id, reason, snapshot)
  VALUES (p_event_id, v_uid, btrim(p_reason), jsonb_build_object('at_request', o))
  RETURNING id INTO v_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (v_uid, 'event_update', 'Cancellation requested',
          'Your request to cancel ' || e.title || ' was sent to VENTS for review. Ticket sales stay open until it is approved.',
          false, '📝', jsonb_build_object('type', 'event_cancellation', 'cancellationId', v_id, 'eventId', p_event_id, 'stage', 'requested'));
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  SELECT u.id, 'event_update', 'Event cancellation to review',
         e.title || ': the organizer requested a cancellation (' || (o->>'paid_tickets') || ' paid ticket(s)).',
         false, '🛑', jsonb_build_object('type', 'event_cancellation', 'cancellationId', v_id, 'eventId', p_event_id, 'stage', 'review')
    FROM public.users u WHERE u.role = 'admin' AND u.deleted_at IS NULL AND u.id <> v_uid;
  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_uid, 'event_cancellation_requested',
          jsonb_build_object('cancellation_id', v_id, 'event_id', p_event_id, 'obligations', o), public.actor_role());

  RETURN jsonb_build_object('id', v_id, 'status', 'requested', 'obligations', o);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A cancellation request for this event is already open';
END;
$function$;

-- The organizer's own requests (or an admin's view), with live refund progress.
CREATE OR REPLACE FUNCTION public.get_my_event_cancellations()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', r.id, 'event_id', r.event_id, 'status', r.status, 'reason', r.reason,
           'requested_at', r.requested_at, 'decided_at', r.decided_at, 'decision_note', r.decision_note,
           'completed_at', r.completed_at,
           'refunds', (SELECT jsonb_build_object(
                          'total', count(*),
                          'refunded', count(*) FILTER (WHERE x.status = 'refunded'),
                          'processing', count(*) FILTER (WHERE x.status IN ('queued', 'processing')),
                          'needs_attention', count(*) FILTER (WHERE x.status IN ('failed', 'blocked')))
                         FROM public.event_cancellation_refunds x WHERE x.request_id = r.id))
           ORDER BY r.requested_at DESC), '[]'::jsonb)
    FROM public.event_cancellation_requests r
   WHERE r.organizer_id = auth.uid();
$function$;

-- An attendee's own refund statuses for cancelled events (no amounts of others).
CREATE OR REPLACE FUNCTION public.get_my_cancellation_refunds()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ticket_id', x.ticket_id, 'event_id', r.event_id, 'status', x.status,
           'amount_kobo', x.amount_kobo, 'payment_method', x.payment_method,
           'refunded_at', x.refunded_at, 'updated_at', x.updated_at)), '[]'::jsonb)
    FROM public.event_cancellation_refunds x
    JOIN public.event_cancellation_requests r ON r.id = x.request_id
   WHERE x.user_id = auth.uid();
$function$;

-- ---------------------------------------------------------------------------
-- 3. Admin review
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_event_cancellations(p_status text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', r.id, 'event_id', r.event_id, 'event_title', e.title, 'event_date', e.event_date,
             'organizer_id', r.organizer_id, 'organizer_name', COALESCE(u.full_name, u.username),
             'status', r.status, 'reason', r.reason, 'requested_at', r.requested_at, 'decided_at', r.decided_at,
             'obligations', public.event_ticket_obligations(r.event_id),
             'refunds', (SELECT jsonb_build_object('total', count(*), 'refunded', count(*) FILTER (WHERE x.status = 'refunded'),
                                                   'needs_attention', count(*) FILTER (WHERE x.status IN ('failed', 'blocked')))
                           FROM public.event_cancellation_refunds x WHERE x.request_id = r.id))
           ORDER BY (r.status IN ('requested', 'attention')) DESC, r.requested_at DESC)
      FROM public.event_cancellation_requests r
      JOIN public.events e ON e.id = r.event_id
      LEFT JOIN public.users u ON u.id = r.organizer_id
     WHERE p_status IS NULL OR r.status = p_status), '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_event_cancellation(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.event_cancellation_requests;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT * INTO r FROM public.event_cancellation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation request not found'; END IF;
  RETURN jsonb_build_object(
    'request', to_jsonb(r),
    'event', (SELECT jsonb_build_object('id', e.id, 'title', e.title, 'event_date', e.event_date, 'status', e.status,
                                        'cancelled_at', e.cancelled_at, 'deleted_at', e.deleted_at)
                FROM public.events e WHERE e.id = r.event_id),
    'organizer', (SELECT jsonb_build_object('id', u.id, 'name', COALESCE(u.full_name, u.username), 'email', u.email)
                    FROM public.users u WHERE u.id = r.organizer_id),
    'obligations', public.event_ticket_obligations(r.event_id),
    -- What refund_ticket would refund now, by payment method (server-side amounts).
    'payments', (SELECT COALESCE(jsonb_object_agg(m, jsonb_build_object('tickets', n, 'kobo', k)), '{}'::jsonb) FROM (
                   SELECT public.event_cancellation_refund_method(t.payment_method, t.amount,
                            public.ticket_fee_buyer_charge_kobo(t.amount, 1, COALESCE(t.discount_percentage, 0), t.fee_model)) AS m,
                          count(*) AS n,
                          sum(public.ticket_fee_buyer_charge_kobo(t.amount, 1, COALESCE(t.discount_percentage, 0), t.fee_model)) AS k
                     FROM public.tickets t WHERE t.event_id = r.event_id AND t.payment_status IN ('paid', 'refund_pending')
                    GROUP BY 1) q),
    'checked_in', (SELECT count(*) FROM public.tickets t WHERE t.event_id = r.event_id AND t.checked_in AND t.payment_status = 'paid'),
    'attendees', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'ticket_id', t.id, 'holder_name', t.holder_name, 'ticket_type', t.ticket_type,
                    'payment_status', t.payment_status, 'payment_method', t.payment_method, 'checked_in', t.checked_in,
                    'refund_status', x.status, 'attempts', x.attempts, 'last_error', x.last_error,
                    -- refund_pending with no Paystack refund id: the API's provider call did not
                    -- return (timeout); check Paystack before reverting it (admin_revert_stuck_refund).
                    'unconfirmed', (t.payment_status = 'refund_pending' AND t.refund_id IS NULL),
                    'amount_kobo', COALESCE(x.amount_kobo, public.ticket_fee_buyer_charge_kobo(t.amount, 1, COALESCE(t.discount_percentage, 0), t.fee_model)))
                    ORDER BY t.created_at), '[]'::jsonb)
                    FROM public.tickets t
                    LEFT JOIN public.event_cancellation_refunds x ON x.ticket_id = t.id
                   WHERE t.event_id = r.event_id AND (t.payment_status IN ('paid', 'refund_pending') OR x.id IS NOT NULL)));
END;
$function$;

-- Queue a refund row for every ticket of a cancelled event that still owes
-- one (also catches a payment that completed after the cancellation).
CREATE OR REPLACE FUNCTION public.event_cancellation_enqueue(p_request_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_event uuid; v_n integer;
BEGIN
  SELECT event_id INTO v_event FROM public.event_cancellation_requests WHERE id = p_request_id;
  INSERT INTO public.event_cancellation_refunds (request_id, ticket_id, user_id, amount_kobo, payment_method, status, last_error)
  SELECT p_request_id, t.id, t.user_id, q.charge,
         public.event_cancellation_refund_method(t.payment_method, t.amount, q.charge),
         CASE WHEN t.checked_in AND t.payment_status = 'paid' THEN 'blocked'
              WHEN t.payment_status = 'refund_pending' THEN 'processing' ELSE 'queued' END,
         CASE WHEN t.checked_in AND t.payment_status = 'paid' THEN 'The ticket was checked in; refund it manually if appropriate' END
    FROM public.tickets t
    CROSS JOIN LATERAL (SELECT GREATEST(0, public.ticket_fee_buyer_charge_kobo(t.amount, 1, COALESCE(t.discount_percentage, 0), t.fee_model)) AS charge) q
   WHERE t.event_id = v_event AND t.payment_status IN ('paid', 'refund_pending')
  ON CONFLICT (ticket_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_decide_event_cancellation(p_request_id uuid, p_approve boolean, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  r public.event_cancellation_requests;
  e public.events;
  o jsonb; v_n integer; v_status text;
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'Approve or reject must be stated'; END IF;
  -- Serializes concurrent decisions: the second one finds it already decided.
  SELECT * INTO r FROM public.event_cancellation_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cancellation request not found'; END IF;
  IF r.status <> 'requested' THEN RAISE EXCEPTION 'This request was already decided (status: %)', r.status; END IF;
  IF r.organizer_id = v_uid THEN RAISE EXCEPTION 'You cannot decide a cancellation of your own event'; END IF;
  SELECT * INTO e FROM public.events WHERE id = r.event_id FOR UPDATE;

  IF NOT p_approve THEN
    IF length(btrim(COALESCE(p_note, ''))) = 0 THEN RAISE EXCEPTION 'A reason is required to reject'; END IF;
    UPDATE public.event_cancellation_requests
       SET status = 'rejected', decided_at = now(), decided_by = v_uid, decision_note = btrim(p_note), updated_at = now()
     WHERE id = r.id;
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (r.organizer_id, 'event_update', 'Cancellation not approved',
            'Your request to cancel ' || e.title || ' was not approved: ' || btrim(p_note) || ' The event stays on sale.',
            false, '↩️', jsonb_build_object('type', 'event_cancellation', 'cancellationId', r.id, 'eventId', r.event_id, 'stage', 'rejected'));
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (v_uid, 'event_cancellation_rejected', jsonb_build_object('cancellation_id', r.id, 'event_id', r.event_id, 'note', btrim(p_note)), public.actor_role());
    RETURN jsonb_build_object('id', r.id, 'status', 'rejected');
  END IF;

  IF e.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'This event has been deleted'; END IF;
  o := public.event_ticket_obligations(r.event_id);
  UPDATE public.event_cancellation_requests
     SET status = 'processing', decided_at = now(), decided_by = v_uid, decision_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
         snapshot = COALESCE(snapshot, '{}'::jsonb) || jsonb_build_object('at_approval', o), updated_at = now()
   WHERE id = r.id;
  -- Closes sales (status 'draft': purchase_ticket, create_pending_purchase
  -- and finalize_pending_purchase all refuse) and stamps the cancellation.
  UPDATE public.events SET cancelled_at = now(), cancellation_request_id = r.id, status = 'draft' WHERE id = r.event_id;
  v_n := public.event_cancellation_enqueue(r.id);

  -- Every ticket holder, once.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  SELECT DISTINCT t.user_id, 'event_update', 'Event cancelled',
         e.title || ' has been cancelled by the organizer. Your refund is being processed to the way you paid; you can follow it in Tix.',
         false, '🛑', jsonb_build_object('type', 'event_cancellation', 'cancellationId', r.id, 'eventId', r.event_id, 'stage', 'cancelled')
    FROM public.tickets t
   WHERE t.event_id = r.event_id AND t.payment_status IN ('paid', 'refund_pending')
     AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.user_id = t.user_id
                      AND n.push_data->>'cancellationId' = r.id::text AND n.push_data->>'stage' = 'cancelled');
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (r.organizer_id, 'event_update', 'Cancellation approved',
          e.title || ' is cancelled and off sale. Refunds to ' || v_n || ' ticket(s) are being processed; follow progress in Manage Events.',
          false, '🛑', jsonb_build_object('type', 'event_cancellation', 'cancellationId', r.id, 'eventId', r.event_id, 'stage', 'approved'));
  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_uid, 'event_cancellation_approved',
          jsonb_build_object('cancellation_id', r.id, 'event_id', r.event_id, 'obligations', o, 'refunds_queued', v_n), public.actor_role());

  v_status := public.event_cancellation_refresh(r.id);
  RETURN jsonb_build_object('id', r.id, 'status', v_status, 'refunds_queued', v_n, 'obligations', o);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Refund processing (each ticket then goes through the existing
--    /api/wallet/refund-ticket -> refund_ticket path)
-- ---------------------------------------------------------------------------
-- Claims up to p_limit refunds to run now. SKIP LOCKED + the 'processing'
-- claim keep two admins (or two tabs) from running the same ticket; a claim
-- whose ticket never left 'paid' is released after 15 minutes. At most 5
-- attempts per ticket; refund_ticket itself refuses a second refund.
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

-- Records that an attempt for one ticket failed (the API's or provider's
-- message). Cannot mark anything refunded: completion only ever comes from
-- the ticket itself reaching 'refunded' (wallet ledger or webhook).
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

-- Mirrors the existing refund path's ticket transitions into the tracking
-- rows (refund_ticket, attach, the webhook's finalize/fail, admin revert).
CREATE OR REPLACE FUNCTION public.event_cancellation_ticket_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_req uuid; x public.event_cancellation_refunds; v_title text;
BEGIN
  IF NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status THEN RETURN NEW; END IF;
  SELECT e.cancellation_request_id, e.title INTO v_req, v_title FROM public.events e WHERE e.id = NEW.event_id;
  IF v_req IS NULL THEN RETURN NEW; END IF;

  IF NEW.payment_status = 'paid' AND OLD.payment_status <> 'refund_pending' THEN
    -- A payment completed after the cancellation: it must be refunded too.
    PERFORM public.event_cancellation_enqueue(v_req);
  ELSE
    SELECT * INTO x FROM public.event_cancellation_refunds WHERE ticket_id = NEW.id FOR UPDATE;
    IF FOUND THEN
      IF NEW.payment_status = 'refund_pending' THEN
        UPDATE public.event_cancellation_refunds SET status = 'processing', updated_at = now() WHERE id = x.id;
      ELSIF NEW.payment_status = 'refunded' THEN
        UPDATE public.event_cancellation_refunds SET status = 'refunded', refunded_at = now(), last_error = NULL, updated_at = now() WHERE id = x.id;
      ELSIF NEW.payment_status = 'paid' AND OLD.payment_status = 'refund_pending' THEN
        -- The provider failed it, or it was reverted: visible, retryable.
        UPDATE public.event_cancellation_refunds
           SET status = 'failed', last_error = COALESCE(last_error, 'The payment provider did not complete the refund; it will be retried'), updated_at = now()
         WHERE id = x.id;
        IF x.status <> 'failed' AND NOT EXISTS (
             SELECT 1 FROM public.notifications n WHERE n.user_id = NEW.user_id
                AND n.push_data->>'cancellationId' = v_req::text AND n.push_data->>'stage' = 'refund_attention'
                AND n.push_data->>'ticketId' = NEW.id::text) THEN
          INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
          VALUES (NEW.user_id, 'booking', 'Refund needs attention',
                  'Your refund for ' || COALESCE(v_title, 'a cancelled event') || ' did not go through yet. VENTS is retrying it; you do not need to do anything.',
                  false, '⚠️', jsonb_build_object('type', 'event_cancellation', 'cancellationId', v_req, 'ticketId', NEW.id, 'stage', 'refund_attention'));
        END IF;
      END IF;
    END IF;
  END IF;
  PERFORM public.event_cancellation_refresh(v_req);
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS event_cancellation_ticket_sync ON public.tickets;
CREATE TRIGGER event_cancellation_ticket_sync AFTER UPDATE OF payment_status ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.event_cancellation_ticket_sync();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.event_ticket_obligations(uuid), public.event_cancellation_refund_method(text, numeric, bigint),
  public.event_cancellation_refresh(uuid), public.event_cancellation_enqueue(uuid), public.events_cancellation_guard(),
  public.event_cancellation_ticket_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_event_cancellation(uuid, text), public.get_my_event_cancellations(),
  public.get_my_cancellation_refunds(), public.admin_list_event_cancellations(text), public.admin_get_event_cancellation(uuid),
  public.admin_decide_event_cancellation(uuid, boolean, text), public.admin_claim_event_cancellation_refunds(uuid, integer),
  public.admin_record_event_cancellation_refund_error(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_event_cancellation(uuid, text), public.get_my_event_cancellations(),
  public.get_my_cancellation_refunds(), public.admin_list_event_cancellations(text), public.admin_get_event_cancellation(uuid),
  public.admin_decide_event_cancellation(uuid, boolean, text), public.admin_claim_event_cancellation_refunds(uuid, integer),
  public.admin_record_event_cancellation_refund_error(uuid, uuid, text) TO authenticated;
