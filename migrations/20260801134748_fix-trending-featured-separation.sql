-- ── Explore / Trending / Featured separation ─────────────────────────────
-- Two real gaps found:
--
-- 1. activate_event_promotion set is_featured=true for BOTH the 'featured'
--    AND 'trending' paid plan_types. An organizer buying a "Trending
--    Boost" was therefore also silently granted Featured-section
--    placement — a paid promotion type unrelated to Featured was able to
--    bypass the Featured gate entirely. Featured must only ever be
--    granted by an actual 'featured' purchase or an admin decision (added
--    below) — never as a side effect of a different plan type.
--
-- 2. There was no admin-manual "mark as featured" path at all — RLS
--    protects is_featured/featured_until from direct writes (correctly),
--    but activate_event_promotion is the ONLY function that can set them,
--    and it requires a paid Paystack reference. An admin had no way to
--    feature an event without going through the paid-purchase RPC on the
--    event owner's behalf, which isn't a real admin action.
--
-- Trending itself was already correctly organic — HomeScreen.tsx's
-- trendingEvents selection has never read is_featured or event_promotions,
-- only real ticket-sale counts. This migration adds a proper multi-signal,
-- recency-weighted score computed server-side (recent booking velocity +
-- total sales + saves) so the client no longer ranks trending purely off
-- lifetime ticket count with no time-decay, matching "recent booking
-- velocity... over a recent time window" — using signals that actually
-- exist in this schema. There is no page-view or share tracking anywhere
-- in this codebase; rather than fabricate those numbers, this only scores
-- on real, auditable data and leaves a clean spot to fold view/share
-- counts in if that tracking is ever added (see comment in the function).

-- ── Fix: only a genuine 'featured' purchase grants Featured placement ────
CREATE OR REPLACE FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_owner_id uuid;
  v_end_date timestamptz;
  v_inserted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_plan_type NOT IN ('boosted', 'featured', 'trending') THEN
    RAISE EXCEPTION 'Invalid plan_type';
  END IF;
  IF p_duration_days NOT IN (3, 7, 14, 30) THEN
    RAISE EXCEPTION 'Invalid duration';
  END IF;
  IF p_payment_ref IS NULL OR trim(p_payment_ref) = '' THEN
    RAISE EXCEPTION 'payment_ref is required';
  END IF;

  SELECT organizer_id INTO v_owner_id FROM public.events WHERE id = p_event_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner_id <> v_user_id THEN
    RAISE EXCEPTION 'You do not own this event';
  END IF;

  v_end_date := now() + make_interval(days => p_duration_days);

  INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status, payment_ref)
  VALUES (p_event_id, v_user_id, p_plan_type, now(), v_end_date, 'active', p_payment_ref)
  ON CONFLICT (payment_ref) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN; -- replayed reference — already activated, no-op
  END IF;

  -- Only 'featured' grants Featured-section placement. 'trending' and
  -- 'boosted' still legitimately raise an event's sort position within
  -- Explore (App.tsx's promotionPlanMap priority ordering, unaffected by
  -- this migration) — that's a real, honest "promoted placement" — but
  -- neither can buy their way into the Featured or Trending sections
  -- themselves.
  IF p_plan_type = 'featured' THEN
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  END IF;
END;
$function$;

-- ── Admin-manual featured (the other legitimate path into Featured) ──────
CREATE OR REPLACE FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer DEFAULT 14)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_end_date timestamptz;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF p_featured AND (p_duration_days IS NULL OR p_duration_days <= 0 OR p_duration_days > 90) THEN
    RAISE EXCEPTION 'Duration must be between 1 and 90 days';
  END IF;

  IF p_featured THEN
    v_end_date := now() + make_interval(days => p_duration_days);
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  ELSE
    UPDATE public.events SET is_featured = false, featured_until = NULL WHERE id = p_event_id;
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  SELECT auth.uid(), CASE WHEN p_featured THEN 'feature_event' ELSE 'unfeature_event' END,
         e.organizer_id, jsonb_build_object('event_id', p_event_id, 'featured', p_featured, 'duration_days', p_duration_days),
         public.actor_role()
  FROM public.events e WHERE e.id = p_event_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) TO authenticated;

-- ── Real, multi-signal, recency-weighted trending score ───────────────────
-- Replaces raw lifetime ticket count with a score reflecting actual
-- current momentum: tickets sold in the last 72h count far more than old
-- sales, plus total sales and saves as steadier engagement signals. Pure
-- SQL over indexed columns (tickets.event_id/status/created_at,
-- saved_events.event_id already indexed) — cheap enough to run per
-- feed-page fetch, same call pattern as get_event_ticket_stats.
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

REVOKE EXECUTE ON FUNCTION public.get_event_trending_scores(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_event_trending_scores(uuid[]) TO anon, authenticated;
