-- Admin-only manual Trending control, mirroring the existing admin manual
-- Featured control (admin_set_event_featured, 0004/0009) so admins no
-- longer have to ask an organizer to buy a promotion just to manually
-- place an eligible event in Trending.
--
-- Deliberately NOT implemented by inflating get_event_trending_scores()'s
-- real, engagement-derived trending_score -- that function stays untouched
-- (see its own comment: recent booking velocity weighted above lifetime
-- sales/saves). Faking a score there would be exactly the "fabricate
-- views/sales/engagement to force trending" this feature must not do, and
-- would corrupt the one real signal that function reports. Instead this is
-- a separate, independent boolean the client merges into the Trending
-- feed alongside (not instead of) the organic ranking -- see
-- HomeScreen.tsx's trendingEvents computation.
--
-- Unlike admin_set_event_featured (which sets a 1-90 day featured_until,
-- matching a paid campaign's own bounded-duration shape), this control has
-- no duration: "Admin-selected placements should remain active until the
-- admin removes them" (explicit product requirement) -- a manually
-- trending event has no paid-campaign-style expiry to mirror in the first
-- place, so there is nothing to silently inherit.

-- 1. New column: a plain, independent boolean -- never written by any paid
-- promotion path (event_promotions/activate_event_promotion never touch
-- it), never read by get_event_trending_scores(). Storing it directly on
-- events (next to the existing is_featured) rather than in event_promotions
-- keeps paid promotion history/entitlements in event_promotions completely
-- untouched by this admin-only, non-monetary flag.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS admin_trending boolean NOT NULL DEFAULT false;

-- 2. Protect it the same way is_featured/featured_until/hidden_by_admin
-- are already protected: any direct write attempted by the `authenticated`
-- role (i.e. an organizer's own client, since update_events RLS has no
-- column-level restriction) is rejected. A SECURITY DEFINER function
-- (below) runs as its owner, not `authenticated`, so the admin RPC path is
-- unaffected by this guard -- same pattern the existing three columns use.
CREATE OR REPLACE FUNCTION public.protect_event_promotion_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_featured IS DISTINCT FROM NEW.is_featured THEN
    RAISE EXCEPTION 'is_featured can only be changed via activate_event_promotion()';
  END IF;
  IF OLD.featured_until IS DISTINCT FROM NEW.featured_until THEN
    RAISE EXCEPTION 'featured_until can only be changed via activate_event_promotion()';
  END IF;
  IF OLD.hidden_by_admin IS DISTINCT FROM NEW.hidden_by_admin THEN
    RAISE EXCEPTION 'hidden_by_admin can only be changed by an admin';
  END IF;
  IF OLD.admin_trending IS DISTINCT FROM NEW.admin_trending THEN
    RAISE EXCEPTION 'admin_trending can only be changed by an admin';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_event_promotion_columns ON public.events;
CREATE TRIGGER trg_protect_event_promotion_columns
  BEFORE UPDATE OF is_featured, featured_until, hidden_by_admin, admin_trending ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.protect_event_promotion_columns();

-- 3. The admin RPC itself. Same authorization tier as admin_set_event_featured
-- (Super Admin only; a Sub-Admin's attempt is rejected here and must go
-- through request_admin_action/approve_admin_action instead, exactly like
-- every other Sub-Admin-restricted admin_* RPC in this codebase -- the
-- client-side maker-checker gate in adminUserEventActions.ts mirrors this,
-- but this check is what actually enforces it).
--
-- Eligibility check (new here -- admin_set_event_featured doesn't have one,
-- but this task explicitly requires it): an event that is hidden, deleted,
-- or not live/published is not eligible for public discovery at all, so it
-- must not be manually placed in Trending either. Unfeaturing/un-trending
-- (p_trending = false) is always allowed regardless of eligibility, so an
-- event that *became* ineligible after being pinned can still be unpinned.
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

REVOKE ALL ON FUNCTION public.admin_set_event_trending(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_event_trending(uuid, boolean) TO authenticated, project_admin;
-- EXECUTE is granted broadly (same grantees as admin_set_event_featured:
-- authenticated + project_admin) because the real gate is the
-- is_super_admin() check inside the function body, not the grant -- any
-- non-admin caller's attempt raises the exception above before it can do
-- anything.
