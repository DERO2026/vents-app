-- Fix: rate_limits and search_synonyms were fully open to anon/authenticated
-- via the Data API (no RLS, full SELECT/INSERT/UPDATE/DELETE grants) despite
-- neither needing direct client access. public_profiles (a view) had unused
-- write grants alongside its legitimately-needed SELECT.
--
-- rate_limits: exploitable today -- any anon client can
-- `DELETE /rest/v1/rate_limits?key=eq.<their own key>` to reset their own
-- signup/login/password-reset throttle on demand, fully defeating
-- brute-force/signup-abuse protection. The broad grants existed because
-- check_auth_rate_limit()/check_rate_limit() are both SECURITY INVOKER --
-- their internal INSERT/UPDATE against rate_limits runs as the actual
-- caller (anon/authenticated), so it needed direct table grants to work at
-- all. Fixed by elevating check_auth_rate_limit() (the one legitimate,
-- parameter-constrained client entry point -- confirmed via grep, only
-- AuthScreen.tsx calls it, with a hardcoded action allow-list and
-- self/IP-scoped keys, never an arbitrary caller-chosen key) to
-- SECURITY DEFINER with a locked search_path, so it keeps working once
-- direct grants are revoked -- it now runs as its owner (postgres, which
-- bypasses RLS by default since this table has no FORCE ROW LEVEL
-- SECURITY), and its nested call to check_rate_limit() inherits that
-- elevated context. check_rate_limit() itself is intentionally NOT changed
-- (still SECURITY INVOKER) -- confirmed via grep that nothing in the
-- frontend calls it directly, so it only ever needs to work when invoked
-- from an already-elevated caller like check_auth_rate_limit(), and leaving
-- it uninvoked-elevated is the smaller change.
--
-- search_synonyms: a static admin-curated search-relevance dictionary with
-- no legitimate direct client need -- confirmed the only consumer,
-- search_events_fuzzy(), is already SECURITY DEFINER (owned by postgres,
-- same bypass-RLS reasoning). Direct anon/authenticated access let anyone
-- vandalize search relevance data platform-wide via the Data API.
--
-- public_profiles: a VIEW (RLS doesn't apply to views at all -- the actual
-- security boundary is get_public_profiles(), which is SECURITY DEFINER
-- and already filters to safe, non-deleted, public-only columns). SELECT
-- is genuinely required (used across App.tsx, ConversationScreen,
-- EventDetailsScreen, ExploreScreen, HomeScreen, InboxScreen) and is left
-- untouched. INSERT/UPDATE/DELETE were unused grants with no INSTEAD OF
-- trigger backing them (so almost certainly already inert), revoked as
-- defense-in-depth.
--
-- project_admin (the role api/_lib/projectAdminDb.ts's server-side webhook/
-- payout code connects as) does NOT bypass RLS, but confirmed via grep that
-- no project_admin-path code touches any of these three tables -- no policy
-- needed for it.

-- ── rate_limits ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_auth_rate_limit(p_action text, p_identifier text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_action NOT IN ('login', 'signup', 'password_reset') THEN
    RAISE EXCEPTION 'Invalid action';
  END IF;

  PERFORM public.check_rate_limit('auth:' || p_action || ':id:' || lower(coalesce(p_identifier, '')), 5, 300);
  PERFORM public.check_rate_limit('auth:' || p_action || ':ip:' || public.client_ip(), 20, 300);
END;
$function$
;

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.rate_limits FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) FROM anon, authenticated;

-- ── search_synonyms ──────────────────────────────────────────────────────
ALTER TABLE public.search_synonyms ENABLE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.search_synonyms FROM anon, authenticated;

-- ── public_profiles (view -- no RLS statement possible/needed) ─────────────
REVOKE INSERT, UPDATE, DELETE ON public.public_profiles FROM anon, authenticated;
