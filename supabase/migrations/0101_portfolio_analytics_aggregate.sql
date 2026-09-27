-- Large-event scalability audit finding #3: SalesAnalyticsScreen.tsx's
-- PortfolioAnalyticsScreen fetched EVERY paid/active ticket row across ALL
-- of an organizer's events with `.select('*')` and no limit, then reduced
-- them in JS for total revenue, a weekday revenue/sales breakdown, and a
-- ticket-type breakdown. Real risk starting ~5,000-10,000 combined tickets
-- across an organizer's events, serious at 50,000.
--
-- Adds a real set-based SQL aggregate, following the same pattern as the
-- existing get_event_analytics (per-event) and get_event_ticket_stats
-- RPCs: SECURITY DEFINER, organizer-or-admin authorization, one query
-- returning pre-aggregated jsonb instead of raw rows.
--
-- Deliberately replicates the CLIENT'S EXISTING computation exactly (same
-- filter: status='active' AND payment_status='paid'; same weekday-name
-- bucketing via day-of-week across the account's entire history, not a
-- calendar-date trend -- this screen's "daily" chart has always aggregated
-- by weekday name, e.g. every Monday ever, not the last 7 calendar days)
-- so this is a pure scale fix, not a behavior change. `to_char(..., 'Dy')`
-- in the default C locale produces 'Mon'/'Tue'/etc, matching the client's
-- own ['Sun','Mon',...][date.getDay()] labels exactly.
--
-- total_capacity/live_events (from the `events` table alone, already a
-- lightweight metadata-only query with no per-ticket cost) and the
-- conversion-rate chart (a client-side ratio of the values below to that
-- capacity) are left computed client-side, unchanged -- only the
-- unbounded per-ticket query/reduce is replaced.

CREATE OR REPLACE FUNCTION public.get_portfolio_analytics(p_organizer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_organizer_id IS DISTINCT FROM v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized to view analytics for this organizer';
  END IF;

  WITH my_events AS (
    SELECT id FROM public.events WHERE organizer_id = p_organizer_id AND deleted_at IS NULL
  ),
  paid AS (
    -- Same revenue-accurate filter as get_event_analytics's own `paid` CTE.
    SELECT t.* FROM public.tickets t
     WHERE t.event_id IN (SELECT id FROM my_events)
       AND t.status = 'active' AND t.payment_status = 'paid'
  ),
  overview AS (
    SELECT
      COALESCE(sum(amount), 0)::numeric AS total_revenue,
      COALESCE(sum(quantity), 0)::integer AS total_qty,
      COALESCE(sum(quantity) FILTER (WHERE checked_in), 0)::integer AS checked_in_qty
    FROM paid
  ),
  by_type AS (
    SELECT COALESCE(ticket_type, 'Regular') AS name, COALESCE(sum(quantity), 0)::integer AS qty
    FROM paid GROUP BY 1
  ),
  by_weekday AS (
    SELECT to_char(created_at, 'Dy') AS day,
           COALESCE(sum(amount), 0)::numeric AS revenue,
           COALESCE(sum(quantity), 0)::integer AS qty
    FROM paid GROUP BY 1
  )
  SELECT jsonb_build_object(
    'totalRevenue', o.total_revenue,
    'totalSales', o.total_qty,
    'checkedInQty', o.checked_in_qty,
    'byTicketType', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', bt.name, 'qty', bt.qty)) FROM by_type bt), '[]'::jsonb),
    'byWeekday', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', bw.day, 'revenue', bw.revenue, 'qty', bw.qty)) FROM by_weekday bw), '[]'::jsonb)
  )
  INTO v_result
  FROM overview o;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_portfolio_analytics(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_portfolio_analytics(uuid) TO authenticated, project_admin;
