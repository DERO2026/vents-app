-- Local-only test schema for run-attendance-visibility-verification.sh.
-- The three public count RPCs as the repository defines them BEFORE 0221:
-- VERBATIM copies of their latest definition (0004_functions.sql; the
-- harness re-checks each copy against the migrations on every run), plus the
-- grants 0011_grants.sql gives them and the one table get_event_trending_scores
-- reads that the shared local stack lacks (0002_tables.sql DDL).
CREATE TABLE IF NOT EXISTS public.saved_events (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, event_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- 0004_functions.sql
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

-- 0004_functions.sql
CREATE OR REPLACE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)
 RETURNS TABLE(ticket_type text, sold_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT t.ticket_type, count(*)::integer AS sold_count
  FROM public.tickets t
  WHERE t.event_id = p_event_id AND t.status = 'active'
  GROUP BY t.ticket_type;
$function$;

-- 0004_functions.sql
CREATE OR REPLACE FUNCTION public.get_event_trending_scores(p_event_ids uuid[])
 RETURNS TABLE(event_id uuid, trending_score numeric, recent_sold integer, total_sold integer, save_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH recent AS (
    SELECT t.event_id, count(*)::integer AS recent_sold
    FROM public.tickets t
    WHERE t.event_id = ANY(p_event_ids) AND t.status = 'active' AND t.created_at > now() - interval '72 hours'
    GROUP BY t.event_id
  ),
  total AS (
    SELECT t.event_id, count(*)::integer AS total_sold
    FROM public.tickets t
    WHERE t.event_id = ANY(p_event_ids) AND t.status = 'active'
    GROUP BY t.event_id
  ),
  saves AS (
    SELECT s.event_id, count(*)::integer AS save_count
    FROM public.saved_events s
    WHERE s.event_id = ANY(p_event_ids)
    GROUP BY s.event_id
  )
  SELECT
    e.id,
    -- Weighted: recent velocity (last 72h) counts 5x, lifetime sales 2x,
    -- saves 1x — momentum matters more than a stale total for "trending
    -- right now". Extend here with view_count/share_count terms if that
    -- tracking is ever added; none exists in this schema today.
    (COALESCE(recent.recent_sold, 0) * 5.0
     + COALESCE(total.total_sold, 0) * 2.0
     + COALESCE(saves.save_count, 0) * 1.0)::numeric AS trending_score,
    COALESCE(recent.recent_sold, 0),
    COALESCE(total.total_sold, 0),
    COALESCE(saves.save_count, 0)
  FROM public.events e
  LEFT JOIN recent ON recent.event_id = e.id
  LEFT JOIN total ON total.event_id = e.id
  LEFT JOIN saves ON saves.event_id = e.id
  WHERE e.id = ANY(p_event_ids);
$function$;

-- 0011_grants.sql
REVOKE ALL ON FUNCTION public.get_event_ticket_stats(p_event_ids uuid[]) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_ticket_stats(p_event_ids uuid[]) TO anon, authenticated, project_admin;
REVOKE ALL ON FUNCTION public.get_event_ticket_type_availability(p_event_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_ticket_type_availability(p_event_id uuid) TO anon, authenticated, project_admin;
REVOKE ALL ON FUNCTION public.get_event_trending_scores(p_event_ids uuid[]) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_event_trending_scores(p_event_ids uuid[]) TO anon, authenticated, project_admin;

