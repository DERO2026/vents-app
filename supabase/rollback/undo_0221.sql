-- Undo 0221 only (supabase/migrations/0221_event_attendance_visibility.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0221';
--   \i supabase/rollback/undo_0221.sql
-- Restores the exact pre-0221 bodies (0004_functions.sql, checked by md5) of
-- the three count RPCs, keeping their owner and grants, and drops
-- events.show_attendance_count. Changes no ticket, payment or other event data.
--
-- Undoing makes every attendance count public again. If any organizer has
-- hidden theirs, the undo also requires
--   SET vents.rollback_reexpose_hidden_counts = 'yes';
-- (their choice is discarded with the column).
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0221' THEN
    RAISE EXCEPTION 'undo_0221 refused: set vents.rollback_confirm = ''undo-0221'' to confirm';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'show_attendance_count') THEN
    IF EXISTS (SELECT 1 FROM public.events WHERE NOT show_attendance_count)
       AND current_setting('vents.rollback_reexpose_hidden_counts', true) IS DISTINCT FROM 'yes' THEN
      RAISE EXCEPTION 'undo_0221 refused: % event(s) hide their attendance count; undoing makes it public again. Set vents.rollback_reexpose_hidden_counts = ''yes'' to proceed',
        (SELECT count(*) FROM public.events WHERE NOT show_attendance_count);
    END IF;
  END IF;
END
$undo$;

-- The pre-0221 bodies, verbatim (0004_functions.sql).

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

-- get_event_ticket_type_availability: its result type differs, so drop and
-- re-create, keeping the current owner and EXECUTE grants.
CREATE TEMP TABLE vents_undo_0221_acl AS
  SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl IS NULL AS default_acl,
         (SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END)
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
    FROM pg_proc p WHERE p.oid = 'public.get_event_ticket_type_availability(uuid)'::regprocedure;

DROP FUNCTION public.get_event_ticket_type_availability(uuid);

CREATE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)
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

DO $acl$
DECLARE
  v record;
  g text;
BEGIN
  SELECT * INTO v FROM vents_undo_0221_acl;
  EXECUTE format('ALTER FUNCTION public.get_event_ticket_type_availability(uuid) OWNER TO %I', v.owner);
  IF NOT v.default_acl THEN
    REVOKE ALL ON FUNCTION public.get_event_ticket_type_availability(uuid) FROM PUBLIC;
    FOREACH g IN ARRAY COALESCE(v.grantees, ARRAY[]::text[]) LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_event_ticket_type_availability(uuid) TO %s', g);
    END LOOP;
  END IF;
END
$acl$;
DROP TABLE vents_undo_0221_acl;

ALTER TABLE public.events DROP COLUMN IF EXISTS show_attendance_count;

DO $check$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('public.get_event_ticket_stats(uuid[])', 'b2548724d5d18d2c99770cf97c27f4a4'),
      ('public.get_event_ticket_type_availability(uuid)', '864e737ffd0e8019d70c74bf82c9ba20'),
      ('public.get_event_trending_scores(uuid[])', 'bc02a20185367e9f15074dda1ce2bdf7')) AS x(sig, md5)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v.sig::regprocedure AND md5(p.prosrc) = v.md5) THEN
      RAISE EXCEPTION 'undo_0221: % was not restored to its exact pre-0221 body; refusing', v.sig;
    END IF;
  END LOOP;
END
$check$;
