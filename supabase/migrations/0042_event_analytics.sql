-- Stage 11: Lightweight Organizer Analytics.
--
-- One new SECURITY DEFINER RPC, get_event_analytics(p_event_id). No new
-- table -- everything is derived from tickets/checkins/events, the same
-- sources get_organizer_events_overview()/get_event_ticket_stats() already
-- use (0004_functions.sql:2049-2114), plus a real calendar-date trend and
-- a ticket-type/check-in breakdown that don't exist anywhere yet.
--
-- Accuracy rules carried over verbatim from those existing functions:
--   - sold/revenue metrics: status='active' AND payment_status='paid' only
--     (excludes pending, and excludes refunded/cancelled automatically --
--     a refunded ticket's payment_status is 'refunded', not 'paid', so it
--     drops out of every filter here without any explicit subtraction).
--   - "remaining" capacity intentionally uses the BROADER status='active'
--     filter (any payment_status), matching get_event_ticket_type_availability
--     (0004_functions.sql:1591) -- pending-payment checkouts must still
--     reserve capacity to prevent overselling during a payment race. This
--     is a different "sold" definition from revenue on purpose; kept
--     separate rather than conflated.
--   - checked-in count/trend reads the `checkins` table, matching
--     get_organizer_events_overview's own checked_in_count source, not
--     tickets.checked_in directly -- keeps this screen consistent with the
--     dashboard organizers already see.
--   - the buyer-paid VENTS service fee is derived per ticket with the
--     EXACT formula confirm_ticket_payment uses (0004_functions.sql /
--     0039_wallet_transaction_metadata.sql): expected = amount * (1.05 -
--     discount_percentage/100), fee = expected - amount. Verified against
--     the live function body before writing this. It is never added into
--     organizer-earned revenue -- shown as a separate informational figure.
--   - VENTS ticketing has no currency column anywhere (confirmed by
--     direct read of events/tickets table definitions) -- everything here
--     is unconditionally NGN; no cross-currency summing is possible today.

CREATE OR REPLACE FUNCTION public.get_event_analytics(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event record;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT id, title, organizer_id, ticket_goal, ticket_types
    INTO v_event
    FROM public.events
   WHERE id = p_event_id;

  IF v_event.id IS NULL THEN RAISE EXCEPTION 'Event not found'; END IF;
  IF v_event.organizer_id IS DISTINCT FROM v_uid AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized to view analytics for this event';
  END IF;

  WITH paid AS (
    -- The one "revenue-accurate" ticket set every metric below that touches
    -- money is filtered from -- active AND paid, nothing else.
    SELECT t.* FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active' AND t.payment_status = 'paid'
  ),
  active_any_payment AS (
    -- The broader "reserves capacity" set -- active regardless of payment_status,
    -- used only for remaining/availability math, never for revenue.
    SELECT t.* FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active'
  ),
  overview AS (
    SELECT
      count(*)::integer AS sold_count,
      COALESCE(sum(quantity), 0)::integer AS sold_quantity,
      COALESCE(sum(amount * 100), 0)::bigint AS gross_kobo,
      -- Per-ticket buyer fee via confirm_ticket_payment's own formula,
      -- summed -- informational only, never added to organizer earnings.
      COALESCE(sum(
        GREATEST(0, round(amount * (1.05 - COALESCE(discount_percentage, 0) / 100) * 100) - floor(amount * 100))
      ), 0)::bigint AS buyer_fee_kobo
    FROM paid
  ),
  counts AS (
    SELECT
      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND status = 'active' AND payment_status = 'pending')::integer AS pending_count,
      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND status = 'cancelled' AND payment_status <> 'refunded')::integer AS cancelled_count,
      (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND payment_status = 'refunded')::integer AS refunded_count
  ),
  by_type_sold AS (
    SELECT ticket_type, count(*)::integer AS sold_count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY ticket_type
  ),
  by_type_reserved AS (
    SELECT ticket_type, count(*)::integer AS reserved_count
    FROM active_any_payment GROUP BY ticket_type
  ),
  type_defs AS (
    SELECT tt->>'name' AS name, NULLIF(tt->>'quantity', '')::integer AS type_quantity
    FROM jsonb_array_elements(COALESCE(v_event.ticket_types, '[]'::jsonb)) tt
  ),
  by_type AS (
    SELECT
      COALESCE(td.name, s.ticket_type, r.ticket_type) AS name,
      COALESCE(s.sold_count, 0) AS sold_count,
      COALESCE(s.revenue_kobo, 0) AS revenue_kobo,
      CASE WHEN td.type_quantity IS NOT NULL
        THEN GREATEST(0, td.type_quantity - COALESCE(r.reserved_count, 0))
        ELSE NULL
      END AS remaining
    FROM type_defs td
    FULL JOIN by_type_sold s ON s.ticket_type = td.name
    FULL JOIN by_type_reserved r ON r.ticket_type = COALESCE(td.name, s.ticket_type)
  ),
  sales_trend AS (
    SELECT date_trunc('day', created_at)::date AS day, count(*)::integer AS count, COALESCE(sum(amount * 100), 0)::bigint AS revenue_kobo
    FROM paid GROUP BY 1 ORDER BY 1
  ),
  checkin_total AS (
    SELECT count(*)::integer AS checked_in_count
    FROM public.checkins WHERE event_id = p_event_id
  ),
  checkin_trend AS (
    SELECT date_trunc('day', checked_in_at)::date AS day, count(*)::integer AS count
    FROM public.checkins WHERE event_id = p_event_id GROUP BY 1 ORDER BY 1
  )
  SELECT jsonb_build_object(
    'eventTitle', v_event.title,
    'currency', 'NGN',
    'overview', jsonb_build_object(
      'soldCount', o.sold_count,
      'soldQuantity', o.sold_quantity,
      'ticketGoal', v_event.ticket_goal,
      'remaining', CASE WHEN v_event.ticket_goal > 0 THEN GREATEST(0, v_event.ticket_goal - o.sold_quantity) ELSE NULL END,
      'grossKobo', o.gross_kobo,
      'buyerFeeKobo', o.buyer_fee_kobo,
      'organizerEarnedKobo', o.gross_kobo,
      'pendingCount', c.pending_count,
      'cancelledCount', c.cancelled_count,
      'refundedCount', c.refunded_count
    ),
    'byTicketType', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', bt.name, 'soldCount', bt.sold_count, 'revenueKobo', bt.revenue_kobo, 'remaining', bt.remaining
      ) ORDER BY bt.revenue_kobo DESC) FROM by_type bt WHERE bt.name IS NOT NULL), '[]'::jsonb),
    'salesTrend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', to_char(st.day, 'YYYY-MM-DD'), 'count', st.count, 'revenueKobo', st.revenue_kobo
      ) ORDER BY st.day) FROM sales_trend st), '[]'::jsonb),
    'attendance', jsonb_build_object(
      'checkedInCount', ck.checked_in_count,
      'soldQuantity', o.sold_quantity,
      'attendancePct', CASE WHEN o.sold_quantity > 0 THEN round((ck.checked_in_count::numeric / o.sold_quantity) * 100, 1) ELSE NULL END
    ),
    'checkinTrend', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', to_char(ct.day, 'YYYY-MM-DD'), 'count', ct.count
      ) ORDER BY ct.day) FROM checkin_trend ct), '[]'::jsonb)
  )
  INTO v_result
  FROM overview o, counts c, checkin_total ck;

  RETURN v_result;
END;
$function$
;

REVOKE ALL ON FUNCTION public.get_event_analytics(uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_analytics(uuid) TO authenticated, project_admin;
