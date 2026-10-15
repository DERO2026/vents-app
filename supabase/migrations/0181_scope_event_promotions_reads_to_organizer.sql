-- DRAFT -- NOT APPLIED TO PRODUCTION (Phase 8 audit deliverable; see Phase 8 report).
--
-- Problem: select_event_promotions (0008) is `TO anon, authenticated USING (true)`,
-- i.e. no row or column restriction at all. Combined with the blanket table GRANT
-- to anon (0012), any client can read every column -- including organizer_id and
-- payment_ref -- for every promotion row, not just the active ones for events it
-- already knows about. The public Home/Explore feed only needs event_id+plan_type
-- for *active, in-window* promotions; it does not need row- or column- level access
-- to the raw table at all.
--
-- Fix: (1) drop anon's row access to the base table entirely and scope authenticated
-- access to the organizer's own rows (matching every write policy already on this
-- table); (2) add a SECURITY DEFINER, STABLE function that returns only
-- (event_id, plan_type) for active/in-window rows, callable by anon and
-- authenticated, which becomes the only public read path. A SECURITY DEFINER
-- function is used instead of a view because a plain Postgres view is NOT
-- automatically "security_invoker" (that defaults to false pre- and post-PG15
-- unless explicitly set), so a bare column-narrowing view here would run as its
-- *owner* -- bypassing the very RLS policy below -- while look like a safe fix. An
-- explicit SECURITY DEFINER function makes the bypass-RLS-on-purpose intent
-- visible and auditable, and hard-codes both the row filter (status/date window)
-- and the column list, so there is nothing for a caller-supplied filter to widen.

-- 1. Base table: remove anon's row access; authenticated only sees their own rows.
DROP POLICY IF EXISTS select_event_promotions ON public.event_promotions;

CREATE POLICY select_event_promotions ON public.event_promotions
  FOR SELECT TO authenticated
  USING (organizer_id = (SELECT auth.uid()));

-- 2. Base table grants: anon no longer needs any privilege on this table (the
-- write grants to anon were already dead -- blocked by RLS -- and are removed too
-- for clarity; the new RPC is the only anon-reachable surface).
REVOKE ALL ON public.event_promotions FROM anon;

-- 3. Public, column-narrow read path for Home/Explore badges.
--
-- Input safeguards: a null/empty array returns no rows rather than erroring
-- (matches App.tsx's existing short-circuit for an empty event_ids list);
-- the array is capped at 200 ids -- comfortably above a single Home/Explore
-- page's event count -- so this cannot be turned into an unbounded-IN-list
-- enumeration/DoS vector by a caller passing an oversized array. search_path
-- is pinned to '' (not just `public`) and every reference is schema-qualified,
-- which is the stricter Supabase-recommended setting for SECURITY DEFINER
-- functions -- it removes any ambiguity from a caller-influenced search_path.
CREATE OR REPLACE FUNCTION public.get_public_event_promotion_badges(p_event_ids uuid[])
RETURNS TABLE (event_id uuid, plan_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ep.event_id, ep.plan_type
  FROM public.event_promotions ep
  WHERE p_event_ids IS NOT NULL
    AND cardinality(p_event_ids) > 0
    AND cardinality(p_event_ids) <= 200
    AND ep.event_id = ANY (p_event_ids)
    AND ep.status = 'active'
    AND now() >= ep.start_date
    AND now() <= ep.end_date;
$$;

REVOKE ALL ON FUNCTION public.get_public_event_promotion_badges(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_event_promotion_badges(uuid[]) TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_event_promotion_badges(uuid[]) IS
  'Public badge read path for event_promotions. Returns only event_id/plan_type for active, in-window promotions. SECURITY DEFINER is deliberate: it is the only sanctioned bypass of the organizer-scoped RLS on event_promotions, and it hard-codes both the row filter and the column list so it cannot be widened by a caller-supplied query.';
