-- 0225: Featured / Trending promotions only for events that are on sale.
--
-- Audit (server paths that grant a promotion; nothing else writes the flags --
-- protect_event_promotion_columns (0182) blocks client writes to is_featured,
-- featured_until, hidden_by_admin and admin_trending):
--   * activate_event_promotion (0180) -- the paid path. project_admin only,
--     called by api/promotions/activate.ts AFTER it verifies the Paystack
--     payment. Checked ownership only: a draft, Coming Soon (0224),
--     cancelled, hidden or ended event could be promoted.
--   * admin_set_event_featured (0090) -- Super Admin (or a Sub-Admin request
--     approved by another admin). No eligibility check at all.
--   * admin_set_event_trending (0182) -- same callers. Already required
--     live/published, not hidden, not deleted; missed cancelled and ended.
--   * event_promotions table: 0008's insert/update/delete policies plus
--     0012's INSERT/UPDATE/DELETE grant let an organizer write promotion rows
--     for their own events straight through the REST API -- an 'active'
--     'trending' row with no payment, or a longer end_date on a paid one.
--     The public badge read (get_public_event_promotion_badges, 0181) reads
--     those rows. No app code writes this table (reads only).
--
-- Fix:
--   * public.event_promotion_block_reason(event): the one rule. NULL when
--     the event may be promoted: exists, not deleted, not cancelled, not
--     admin-hidden, status 'live' (or 'published', as event_is_active), not
--     ended. Otherwise the reason. Draft and Coming Soon are not on sale.
--   * The three functions above call it when ENABLING a promotion only.
--     Turning a promotion off is never blocked. Each body is re-created from
--     the repo text with only that check inserted, and is md5-pinned below:
--     if production has drifted, this migration refuses instead of
--     overwriting an unknown definition. The only accepted alternative is
--     admin_set_event_featured's verified production body, which differs
--     from the repo body by two comment lines only.
--   * activate_event_promotion keeps its replay behaviour: a payment_ref that
--     was already activated returns before the new check.
--   * get_event_promotion_eligibility(event): the same rule for the app to
--     check BEFORE opening the Paystack popup (organizer's own events, or
--     admin), so nobody pays for a promotion the server would refuse.
--   * event_promotions: client INSERT/UPDATE/DELETE removed (policies and
--     grants). Organizers keep reading their own rows (0181). project_admin
--     (the paid path) is unchanged.
--
-- Unchanged: prices, durations, the Paystack verification, the badge read
-- path, existing promotion rows, and promotions on eligible live events.
--
-- Production: NOT applied by this change. Apply only with owner approval.
-- Rollback: supabase/rollback/undo_0225.sql.

DO $pre$
DECLARE
  -- Each function may be in exactly one of the listed states, nothing else.
  -- admin_set_event_featured has two approved variants: the reviewed repo
  -- body (0090) and the verified production body, which is the same code
  -- without 0090's two comment lines ("-- Was: is_admin(). Sub-Admins must
  -- now submit ...") -- read-only production check, 2026-11-25.
  v_pins jsonb := '{"activate_event_promotion": ["8f8932cb3c011315d227d4dc3295df84"], "admin_set_event_featured": ["cb47d23e3c486406259f41fe9cc01ceb", "66a3bd2f21ec0813a5aa8e9100ed8aec"], "admin_set_event_trending": ["77b628b0cc71e848cf0a1024238da46f"]}';
  v_name text;
  v_live text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'cancelled_at') THEN
    RAISE EXCEPTION '0225 requires 0218 (events.cancelled_at is missing)';
  END IF;
  IF to_regprocedure('public.event_effective_end_at(timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '0225 requires event_effective_end_at (0051)';
  END IF;
  FOR v_name IN SELECT jsonb_object_keys(v_pins) LOOP
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_name;
    IF v_live IS NULL OR NOT ((v_pins->v_name) ? v_live) THEN
      RAISE EXCEPTION '0225 refused: public.% differs from the definition this migration was written against (live md5 %, expected one of %)',
        v_name, COALESCE(v_live, 'missing'), v_pins->v_name;
    END IF;
  END LOOP;
END
$pre$;

-- ── The one eligibility rule ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.event_promotion_block_reason(p_event_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN e.id IS NULL THEN 'not_found'
    WHEN e.deleted_at IS NOT NULL THEN 'deleted'
    WHEN e.cancelled_at IS NOT NULL THEN 'cancelled'
    WHEN e.hidden_by_admin THEN 'hidden_by_admin'
    WHEN e.status NOT IN ('live', 'published') THEN 'not_on_sale'
    WHEN now() >= public.event_effective_end_at(e.event_date, e.end_date) THEN 'ended'
    ELSE NULL
  END
  FROM (SELECT 1) AS one
  LEFT JOIN public.events e ON e.id = p_event_id;
$function$;
REVOKE ALL ON FUNCTION public.event_promotion_block_reason(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_promotion_block_reason(uuid) TO project_admin;

-- For the app, before payment: the organizer's own event (or an admin).
CREATE OR REPLACE FUNCTION public.get_event_promotion_eligibility(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_reason text;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.events e
     WHERE e.id = p_event_id AND (e.organizer_id = auth.uid() OR COALESCE(public.is_admin(), false))
  ) THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'not_found');
  END IF;
  v_reason := public.event_promotion_block_reason(p_event_id);
  RETURN jsonb_build_object('eligible', v_reason IS NULL, 'reason', v_reason);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_event_promotion_eligibility(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_event_promotion_eligibility(uuid) TO authenticated, project_admin;

-- ── The three granting paths (repo bodies + the check; grants unchanged by
-- CREATE OR REPLACE) ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text, p_organizer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner_id uuid;
  v_end_date timestamptz;
  v_inserted integer;
  v_block    text;
BEGIN
  IF p_organizer_id IS NULL THEN
    RAISE EXCEPTION 'organizer_id is required';
  END IF;
  IF p_plan_type NOT IN ('featured', 'trending') THEN
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
  IF v_owner_id <> p_organizer_id THEN
    RAISE EXCEPTION 'You do not own this event';
  END IF;

  -- 0225: a replayed reference stays a no-op (checked before eligibility,
  -- so retrying an already-activated payment never errors), and a new
  -- promotion needs an event that is on sale (event_promotion_block_reason).
  IF EXISTS (SELECT 1 FROM public.event_promotions WHERE payment_ref = p_payment_ref) THEN
    RETURN;
  END IF;
  v_block := public.event_promotion_block_reason(p_event_id);
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION 'This event is not eligible for promotion (%)', v_block;
  END IF;

  v_end_date := now() + make_interval(days => p_duration_days);

  INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status, payment_ref)
  VALUES (p_event_id, p_organizer_id, p_plan_type, now(), v_end_date, 'active', p_payment_ref)
  ON CONFLICT (payment_ref) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN; -- replayed reference — already activated, no-op
  END IF;

  IF p_plan_type = 'featured' THEN
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer DEFAULT 14)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_end_date timestamptz;
  v_block    text;
BEGIN
  -- Was: is_admin(). Sub-Admins must now submit via request_admin_action
  -- ('toggle_event_featured') and have an Admin/Root approve it (see 0092).
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required to feature an event (your role: %). Sub-Admins must submit this for approval.',
      COALESCE(public.actor_role(), 'none');
  END IF;
  IF p_featured AND (p_duration_days IS NULL OR p_duration_days <= 0 OR p_duration_days > 90) THEN
    RAISE EXCEPTION 'Duration must be between 1 and 90 days';
  END IF;

  IF p_featured THEN
    -- 0225: only an event that is on sale can be featured.
    v_block := public.event_promotion_block_reason(p_event_id);
    IF v_block IS NOT NULL THEN
      RAISE EXCEPTION 'This event is not eligible for promotion (%)', v_block;
    END IF;
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

CREATE OR REPLACE FUNCTION public.admin_set_event_trending(p_event_id uuid, p_trending boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_event public.events;
  v_block text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required to set an event''s Trending placement (your role: %). Sub-Admins must submit this for approval.',
      COALESCE(public.actor_role(), 'none');
  END IF;

  SELECT * INTO v_event FROM public.events WHERE id = p_event_id;
  IF v_event.id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF p_trending THEN
    IF v_event.hidden_by_admin THEN
      RAISE EXCEPTION 'Event is hidden by admin and not eligible for public discovery';
    END IF;
    IF v_event.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Event is deleted and not eligible for public discovery';
    END IF;
    IF v_event.status NOT IN ('live', 'published') THEN
      RAISE EXCEPTION 'Event status (%) is not eligible for public discovery', v_event.status;
    END IF;
    -- 0225: also refuses cancelled and ended events (same rule as paid promotions).
    v_block := public.event_promotion_block_reason(p_event_id);
    IF v_block IS NOT NULL THEN
      RAISE EXCEPTION 'This event is not eligible for promotion (%)', v_block;
    END IF;
  END IF;

  UPDATE public.events SET admin_trending = p_trending WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), CASE WHEN p_trending THEN 'trend_event' ELSE 'untrend_event' END,
          v_event.organizer_id, jsonb_build_object('event_id', p_event_id, 'trending', p_trending),
          public.actor_role());
END;
$function$;

-- ── event_promotions: no client writes ─────────────────────────────────────
DROP POLICY IF EXISTS insert_event_promotions ON public.event_promotions;
DROP POLICY IF EXISTS update_event_promotions ON public.event_promotions;
DROP POLICY IF EXISTS delete_event_promotions ON public.event_promotions;
REVOKE INSERT, UPDATE, DELETE ON public.event_promotions FROM PUBLIC, anon, authenticated;
