-- ── Organizer Hub → My Created Events: production-grade data layer ──────────
-- The screen previously worked off a raw `events.select('*')` fetched once on
-- mount/organizer-switch, with NO ticket/revenue aggregates, NO realtime, and
-- a client-side status remap that actively lied about the real DB status
-- ('live' displayed as 'approved', 'draft' displayed as 'under_review',
-- "promoted" by fake setTimeout timers with zero backend behind them --
-- public.events.status only ever has 'live'/'draft' per its CHECK
-- constraint). This adds a single aggregate RPC returning everything the
-- screen needs in one call (real status, sold/pending/revenue counts,
-- checked-in count, and computed is_ended/is_sold_out), plus a realtime
-- channel so the screen updates live when tickets sell or an event changes,
-- with no manual refresh.

-- ── 1. Narrow get_event_ticket_stats's revenue field to the event's own
-- organizer (or admin) -- it's callable by any authenticated user (needed
-- for public "N sold" displays on HomeScreen/EventDetailsScreen), but
-- revenue is financial data that shouldn't be readable by an arbitrary
-- caller passing someone else's event ids. Grepped every call site in the
-- repo: none currently reads revenue_kobo, so this is a pure narrowing with
-- no behavior change for existing callers.
CREATE OR REPLACE FUNCTION public.get_event_ticket_stats(p_event_ids uuid[])
 RETURNS TABLE(event_id uuid, sold_count integer, sold_quantity integer, pending_count integer, cancelled_count integer, refunded_count integer, revenue_kobo bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    t.event_id,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid')::integer AS sold_count,
    COALESCE(sum(t.quantity) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::integer AS sold_quantity,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'pending')::integer AS pending_count,
    count(*) FILTER (WHERE t.status = 'cancelled' AND t.payment_status <> 'refunded')::integer AS cancelled_count,
    count(*) FILTER (WHERE t.payment_status = 'refunded')::integer AS refunded_count,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin()
      THEN COALESCE(sum(t.amount * 100) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::bigint
      ELSE NULL
    END AS revenue_kobo
  FROM public.tickets t
  JOIN public.events e ON e.id = t.event_id
  WHERE t.event_id = ANY(p_event_ids)
  GROUP BY t.event_id, e.organizer_id;
$function$;

-- ── 2. One-call overview for "My Created Events" ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_organizer_events_overview()
 RETURNS TABLE(
  id uuid, title text, description text, location text, event_date timestamptz,
  price numeric, ticket_goal integer, ticket_types jsonb, status text,
  is_18_plus boolean, created_at timestamptz,
  sold_count integer, sold_quantity integer, pending_count integer,
  cancelled_count integer, refunded_count integer, revenue_kobo bigint,
  checked_in_count integer, is_ended boolean, is_sold_out boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_organizer uuid := auth.uid();
BEGIN
  IF v_organizer IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  WITH my_events AS (
    SELECT * FROM public.events WHERE organizer_id = v_organizer AND deleted_at IS NULL
  ),
  stats AS (
    SELECT * FROM public.get_event_ticket_stats((SELECT array_agg(id) FROM my_events))
  ),
  checkins_agg AS (
    SELECT ci.event_id, count(*)::integer AS checked_in_count
    FROM public.checkins ci
    WHERE ci.event_id IN (SELECT id FROM my_events)
    GROUP BY ci.event_id
  )
  SELECT
    e.id, e.title, e.description, e.location, e.event_date,
    e.price, e.ticket_goal, e.ticket_types, e.status, e.is_18_plus, e.created_at,
    COALESCE(s.sold_count, 0), COALESCE(s.sold_quantity, 0), COALESCE(s.pending_count, 0),
    COALESCE(s.cancelled_count, 0), COALESCE(s.refunded_count, 0), COALESCE(s.revenue_kobo, 0),
    COALESCE(ck.checked_in_count, 0),
    (e.event_date < now()),
    (e.ticket_goal > 0 AND COALESCE(s.sold_quantity, 0) >= e.ticket_goal)
  FROM my_events e
  LEFT JOIN stats s ON s.event_id = e.id
  LEFT JOIN checkins_agg ck ON ck.event_id = e.id
  ORDER BY e.created_at DESC;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_organizer_events_overview() TO authenticated;

-- ── 3. Realtime: per-organizer channel so the dashboard refreshes live ───────
-- Mirrors the door:% pattern. PII-free payload (event_id only) — a refetch
-- signal; the real data stays behind the gated RPC above.
INSERT INTO realtime.channels (pattern, description, enabled)
VALUES ('organizer-events:%', 'Live updates for an organizer''s Created Events dashboard', true)
ON CONFLICT (pattern) DO UPDATE
  SET description = EXCLUDED.description, enabled = EXCLUDED.enabled;

CREATE OR REPLACE FUNCTION public.notify_organizer_events_ticket()
RETURNS TRIGGER AS $function$
DECLARE v_organizer_id uuid;
BEGIN
  SELECT organizer_id INTO v_organizer_id FROM public.events WHERE id = NEW.event_id;
  IF v_organizer_id IS NOT NULL THEN
    PERFORM realtime.publish(
      'organizer-events:' || v_organizer_id::text,
      'tickets_changed',
      jsonb_build_object('event_id', NEW.event_id)
    );
  END IF;
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_organizer_events_ticket ON public.tickets;
CREATE TRIGGER trg_organizer_events_ticket
AFTER INSERT OR UPDATE OF status, payment_status ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.notify_organizer_events_ticket();

CREATE OR REPLACE FUNCTION public.notify_organizer_events_event()
RETURNS TRIGGER AS $function$
BEGIN
  IF NEW.organizer_id IS NOT NULL THEN
    PERFORM realtime.publish(
      'organizer-events:' || NEW.organizer_id::text,
      'event_changed',
      jsonb_build_object('event_id', NEW.id)
    );
  END IF;
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_organizer_events_event ON public.events;
CREATE TRIGGER trg_organizer_events_event
AFTER INSERT OR UPDATE OF status, deleted_at, title, event_date, price, ticket_goal, ticket_types
ON public.events
FOR EACH ROW EXECUTE FUNCTION public.notify_organizer_events_event();
