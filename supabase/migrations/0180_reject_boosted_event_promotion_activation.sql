-- VENTS Phase 6 -- Spotlight Boost removed from the purchasable product
-- lineup; VENTS promotions now sell only Trending and Featured. The
-- client (PromoteEventScreen.tsx) and the server-side verify-and-activate
-- endpoint (api/promotions/activate.ts) already reject a new Spotlight
-- purchase/activation request before this migration, via
-- src/lib/eventPromotionPricing.ts's isEventPromotionPlan() no longer
-- including 'spotlight'/'boosted' at all. This migration closes the same
-- gap at the database layer, which is the only other path that could ever
-- insert a new event_promotions row: activate_event_promotion() itself
-- still accepted p_plan_type='boosted' and would happily activate one if
-- reached directly (it's project_admin-only per 0137, so only this
-- codebase's own server code can call it today -- but that's exactly
-- api/promotions/activate.ts, and defense-in-depth means the database
-- shouldn't rely solely on the application layer agreeing not to pass
-- 'boosted' through).
--
-- Deliberately NOT touched, and why:
--   - The `event_promotions.plan_type` CHECK constraint
--     (event_promotions_plan_type_check, 0005) still allows 'boosted'.
--     Tightening it to exclude 'boosted' would need Postgres to validate
--     every EXISTING row against the new constraint, which fails the
--     whole migration outright if even one historical 'boosted' row
--     exists -- a real possibility this migration has no way to check
--     from a static SQL file, and the task explicitly rules out a
--     destructive production change. Rejecting new 'boosted' activations
--     inside activate_event_promotion() (below) is sufficient on its own:
--     it is the ONLY function with INSERT privilege on event_promotions
--     (0011's grants aside -- those predate the 0137 lockdown and are
--     effectively moot now that this function runs over the
--     project_admin connection exclusively from server code that itself
--     refuses to send 'boosted'), so no new row can be created with that
--     plan_type regardless of what the table-level CHECK still permits.
--   - No existing `event_promotions` row is read, written, or deleted by
--     this migration. Historical Spotlight/'boosted' promotions (if any
--     exist in production -- not verified from this static file) remain
--     exactly as they are, and HomeScreen.tsx's promoPlan badge continues
--     to render "SPOTLIGHT" for them correctly, since that display logic
--     was never touched.
--   - Function signature is unchanged (still
--     (uuid, text, integer, text, uuid), same as 0137), so CREATE OR
--     REPLACE is sufficient -- no DROP FUNCTION, no re-GRANT needed; the
--     existing REVOKE/GRANT from 0137 (project_admin only) already
--     covers this replacement.

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
