-- ── Fix ambiguous "id" column reference in get_organizer_events_overview ────
-- Caught by a live functional smoke test immediately after deploying the
-- prior migration: PL/pgSQL's RETURNS TABLE implicitly declares an OUT
-- variable named `id` (the function's first output column) inside the
-- function body. The CTEs referenced `id` unqualified (`array_agg(id) FROM
-- my_events`, `SELECT id FROM my_events`), which Postgres could not
-- disambiguate between that OUT variable and `my_events.id` -- the RPC
-- failed on every call with "column reference \"id\" is ambiguous" (42702).
-- Fix: qualify both references as `my_events.id`.

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
    SELECT * FROM public.get_event_ticket_stats((SELECT array_agg(my_events.id) FROM my_events))
  ),
  checkins_agg AS (
    SELECT ci.event_id, count(*)::integer AS checked_in_count
    FROM public.checkins ci
    WHERE ci.event_id IN (SELECT my_events.id FROM my_events)
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
