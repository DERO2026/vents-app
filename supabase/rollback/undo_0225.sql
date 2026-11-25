-- Undo 0225 only (supabase/migrations/0225_promotion_eligibility.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0225';
--   \i supabase/rollback/undo_0225.sql
-- Restores activate_event_promotion (0180), admin_set_event_featured (0090)
-- and admin_set_event_trending (0182) verbatim, drops the two 0225
-- functions, and restores 0008's organizer write policies and 0012's
-- INSERT/UPDATE/DELETE grant on event_promotions to authenticated.
-- admin_set_event_featured is restored as the reviewed repo body (0090). If
-- production held the approved comment-less variant before 0225 (md5
-- 66a3bd2f...), the restored body differs from it by those two comment
-- lines only; the executable code is identical.
-- WARNING: that last step re-opens the gap 0225 closed (an organizer can
-- write promotion rows for their own events without paying). Promotion rows
-- and event flags are not touched; no money is moved.
DO $undo$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0225' THEN
    RAISE EXCEPTION 'undo_0225 refused: set vents.rollback_confirm = ''undo-0225'' to confirm';
  END IF;
END
$undo$;

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
  END IF;

  UPDATE public.events SET admin_trending = p_trending WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), CASE WHEN p_trending THEN 'trend_event' ELSE 'untrend_event' END,
          v_event.organizer_id, jsonb_build_object('event_id', p_event_id, 'trending', p_trending),
          public.actor_role());
END;
$function$;

DROP FUNCTION IF EXISTS public.get_event_promotion_eligibility(uuid);
DROP FUNCTION IF EXISTS public.event_promotion_block_reason(uuid);

DROP POLICY IF EXISTS insert_event_promotions ON public.event_promotions;
DROP POLICY IF EXISTS update_event_promotions ON public.event_promotions;
DROP POLICY IF EXISTS delete_event_promotions ON public.event_promotions;
CREATE POLICY delete_event_promotions ON public.event_promotions FOR DELETE TO authenticated USING ((organizer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY insert_event_promotions ON public.event_promotions FOR INSERT TO authenticated WITH CHECK (((organizer_id = ( SELECT auth.uid() AS uid)) AND (event_id IN ( SELECT events.id
   FROM public.events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY update_event_promotions ON public.event_promotions FOR UPDATE TO authenticated USING ((organizer_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((organizer_id = ( SELECT auth.uid() AS uid)));
GRANT INSERT, UPDATE, DELETE ON public.event_promotions TO authenticated;
