-- 0221: event attendance visibility. An organizer can choose whether the
-- public sees how many people are attending their event. The event itself
-- stays visible and on sale; tickets, payments, QR passes, check-in, refunds,
-- promotion and the organizer's own analytics are unchanged.
--
-- Before this migration every attendance count was public: three public
-- RPCs, granted to anon (0011_grants.sql), returned them for any event:
--   * get_event_ticket_stats: sold_count / sold_quantity, and also the
--     pending / cancelled / refunded counts, to anyone.
--   * get_event_ticket_type_availability: per-tier sold counts (summing to
--     the event total).
--   * get_event_trending_scores: recent_sold and total_sold (both counting
--     every 'active' ticket, pending ones included), and a score derived
--     from them.
-- Hiding a number in the app alone would leave all three readable.
--
-- This migration:
--   1. events.show_attendance_count boolean NOT NULL DEFAULT true. Adding it
--      with that default sets every existing event to true (counts stay
--      public, exactly as today); new events default to true as well. Only
--      the organizer (or an admin) can change it: the existing events UPDATE
--      policy (0008, organizer_id = auth.uid() OR is_admin()) is unchanged.
--   2. get_event_ticket_stats: for an event that hides its count, returns NO
--      row to anyone but its organizer and admins (is_admin(): admins and
--      sub-admins). pending / cancelled / refunded counts go only to the
--      organizer and admins, for every event (they were never shown publicly
--      in the app). Organizer/admin results are unchanged.
--   3. get_event_ticket_type_availability: adds sold_out (per tier, the exact
--      capacity rule purchase_ticket enforces: the tier's quantity, or the
--      event's ticket_goal, reached by 'active' tickets) and returns a row per
--      tier. sold_count is NULL for a hidden event unless the caller is its
--      organizer or an admin; buyers still see which tiers are sold out.
--      Its result type changes, so it is dropped and re-created; its owner and
--      its EXECUTE grants are captured first and restored exactly.
--   4. get_event_trending_scores: recent_sold / total_sold go only to the
--      organizer and admins. A hidden event's trending_score counts saves
--      only (no ticket terms), for everyone, so the score cannot be inverted
--      into a sales figure.
--
-- Not changed: ticket purchase / checkout / capacity enforcement, ticket
-- integrity (0220), refunds, cancellation (0218/0219), fees, payouts,
-- promotion, grants on anything else, RLS. Moves no money; changes no ticket.
-- Known limit (docs/event-attendance-visibility.md): capacity (ticket_goal,
-- tier quantities) stays public and checkout still enforces it, so a buyer
-- can still learn how many seats remain by attempting purchases.
--
-- Each function must be the repository version (0004_functions.sql, pinned
-- by md5(prosrc)) or already carry [0221]; anything else refuses the whole
-- migration before any change. One transaction; idempotent.
-- Rollback: supabase/rollback/undo_0221.sql.

DO $pre$
DECLARE
  v record;
BEGIN
  IF to_regclass('public.events') IS NULL OR to_regclass('public.tickets') IS NULL THEN
    RAISE EXCEPTION '0221: events/tickets missing; refusing';
  END IF;
  FOR v IN SELECT * FROM (VALUES
      ('public.get_event_ticket_stats(uuid[])', 'b2548724d5d18d2c99770cf97c27f4a4'),
      ('public.get_event_ticket_type_availability(uuid)', '864e737ffd0e8019d70c74bf82c9ba20'),
      ('public.get_event_trending_scores(uuid[])', 'bc02a20185367e9f15074dda1ce2bdf7')) AS x(sig, md5)
  LOOP
    IF to_regprocedure(v.sig) IS NULL THEN
      RAISE EXCEPTION '0221: % is missing; refusing', v.sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)
                    AND (md5(p.prosrc) = v.md5 OR position('[0221]' IN p.prosrc) > 0)) THEN
      RAISE EXCEPTION '0221: % is not the expected version (md5 of its body differs from the repository''s); refusing', v.sig;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The setting
-- ---------------------------------------------------------------------------
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS show_attendance_count boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.events.show_attendance_count IS
  'Organizer choice: whether the public sees how many people are attending. Enforced by get_event_ticket_stats, get_event_ticket_type_availability and get_event_trending_scores (0221). Default true.';

-- ---------------------------------------------------------------------------
-- 2. get_event_ticket_stats (same signature and result type)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_event_ticket_stats(p_event_ids uuid[])
 RETURNS TABLE(event_id uuid, sold_count integer, sold_quantity integer, pending_count integer, cancelled_count integer, refunded_count integer, revenue_kobo bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- [0221] An event whose organizer hides its attendance count returns no
  -- row except to that organizer and admins. Pending / cancelled / refunded
  -- counts and revenue are organizer/admin-only for every event.
  SELECT
    t.event_id,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid')::integer AS sold_count,
    COALESCE(sum(t.quantity) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::integer AS sold_quantity,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin()
      THEN count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'pending')::integer END AS pending_count,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin()
      THEN count(*) FILTER (WHERE t.status = 'cancelled' AND t.payment_status <> 'refunded')::integer END AS cancelled_count,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin()
      THEN count(*) FILTER (WHERE t.payment_status = 'refunded')::integer END AS refunded_count,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin()
      THEN COALESCE(sum(t.amount * 100) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::bigint
      ELSE NULL
    END AS revenue_kobo
  FROM public.tickets t
  JOIN public.events e ON e.id = t.event_id
  WHERE t.event_id = ANY(p_event_ids)
    AND (e.show_attendance_count OR e.organizer_id = auth.uid() OR public.is_admin())
  GROUP BY t.event_id, e.organizer_id;
$function$;

-- ---------------------------------------------------------------------------
-- 3. get_event_ticket_type_availability (result type gains sold_out)
-- ---------------------------------------------------------------------------
-- Keep the current owner and EXECUTE grants (NULL acl = the default PUBLIC execute).
CREATE TEMP TABLE vents_0221_avail_acl AS
  SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl IS NULL AS default_acl,
         (SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END)
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees
    FROM pg_proc p WHERE p.oid = 'public.get_event_ticket_type_availability(uuid)'::regprocedure;

DROP FUNCTION public.get_event_ticket_type_availability(uuid);

CREATE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)
 RETURNS TABLE(ticket_type text, sold_count integer, sold_out boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- [0221] One row per tier (from ticket_types, plus any type that has
  -- tickets). sold_out applies purchase_ticket's capacity rule: 'active'
  -- tickets (any payment status) reaching the tier's quantity or the event's
  -- ticket_goal. sold_count is NULL when the organizer hides the attendance
  -- count, unless the caller is the organizer or an admin.
  WITH ev AS (
    SELECT e.ticket_goal,
           CASE WHEN jsonb_typeof(e.ticket_types) = 'array' THEN e.ticket_types ELSE '[]'::jsonb END AS tiers,
           (e.show_attendance_count OR e.organizer_id = auth.uid() OR public.is_admin()) IS TRUE AS can_see
      FROM public.events e
     WHERE e.id = p_event_id
  ),
  sold AS (
    SELECT t.ticket_type, count(*)::integer AS n
      FROM public.tickets t
     WHERE t.event_id = p_event_id AND t.status = 'active'
     GROUP BY t.ticket_type
  ),
  total AS (SELECT COALESCE(sum(sold.n), 0)::integer AS n FROM sold),
  lim AS (
    SELECT DISTINCT ON (x.value->>'name') x.value->>'name' AS ticket_type,
           CASE WHEN (x.value->>'quantity') ~ '^[0-9]+$' THEN (x.value->>'quantity')::integer END AS lim
      FROM ev, jsonb_array_elements(ev.tiers) WITH ORDINALITY AS x(value, ord)
     WHERE x.value->>'name' IS NOT NULL
     ORDER BY x.value->>'name', x.ord
  ),
  types AS (SELECT sold.ticket_type FROM sold UNION SELECT lim.ticket_type FROM lim)
  SELECT ty.ticket_type,
         CASE WHEN ev.can_see THEN COALESCE(s.n, 0) END,
         (COALESCE(l.lim, 0) > 0 AND COALESCE(s.n, 0) >= l.lim)
           OR (COALESCE(ev.ticket_goal, 0) > 0 AND total.n >= ev.ticket_goal)
    FROM types ty
   CROSS JOIN ev
   CROSS JOIN total
    LEFT JOIN sold s ON s.ticket_type IS NOT DISTINCT FROM ty.ticket_type
    LEFT JOIN lim l ON l.ticket_type IS NOT DISTINCT FROM ty.ticket_type;
$function$;

DO $acl$
DECLARE
  v record;
  g text;
BEGIN
  SELECT * INTO v FROM vents_0221_avail_acl;
  EXECUTE format('ALTER FUNCTION public.get_event_ticket_type_availability(uuid) OWNER TO %I', v.owner);
  IF NOT v.default_acl THEN
    REVOKE ALL ON FUNCTION public.get_event_ticket_type_availability(uuid) FROM PUBLIC;
    FOREACH g IN ARRAY COALESCE(v.grantees, ARRAY[]::text[]) LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_event_ticket_type_availability(uuid) TO %s', g);
    END LOOP;
  END IF;
END
$acl$;
DROP TABLE vents_0221_avail_acl;

-- ---------------------------------------------------------------------------
-- 4. get_event_trending_scores (same signature and result type)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_event_trending_scores(p_event_ids uuid[])
 RETURNS TABLE(event_id uuid, trending_score numeric, recent_sold integer, total_sold integer, save_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- [0221] Raw sales figures go only to the event's organizer and admins. An
  -- event that hides its attendance count is scored on saves alone, for
  -- everyone, so its score cannot be turned back into a sales figure.
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
    -- saves 1x (unchanged); the ticket terms only for an event that shows
    -- its attendance count.
    (CASE WHEN e.show_attendance_count
       THEN COALESCE(recent.recent_sold, 0) * 5.0 + COALESCE(total.total_sold, 0) * 2.0
       ELSE 0 END
     + COALESCE(saves.save_count, 0) * 1.0)::numeric AS trending_score,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin() THEN COALESCE(recent.recent_sold, 0) END,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin() THEN COALESCE(total.total_sold, 0) END,
    COALESCE(saves.save_count, 0)
  FROM public.events e
  LEFT JOIN recent ON recent.event_id = e.id
  LEFT JOIN total ON total.event_id = e.id
  LEFT JOIN saves ON saves.event_id = e.id
  WHERE e.id = ANY(p_event_ids);
$function$;
