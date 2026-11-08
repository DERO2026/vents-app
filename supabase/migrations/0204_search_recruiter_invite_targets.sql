-- 0204: Representative "Find" search returns only invitable users and
-- matches partial usernames.
--
-- STATUS: NOT APPLIED to production. Written for review alongside PR #82
-- (0201-0203 are also unapplied). Apply only after 0201, in its own
-- transaction, never with `supabase db push`. Verify the live definition
-- afterwards with pg_get_functiondef.
--
-- Why this exists (verified against production on 2026-10-31):
--
-- RepresentativesScreen's Find tab reused search_users_for_request (0069),
-- the checkout/ticket-transfer autocomplete. Its live body:
--   * matches PREFIXES only (`username ILIKE q || '%'`), so "ade" finds
--     "adebayo" but "bayo" finds nothing -- no partial matching;
--   * returns ANY user (LIMIT 8), so the 8 slots fill with plain attendees
--     a representative cannot invite, while real organizers/providers
--     further down the alphabet never appear;
--   * shares one 30-calls/60s bucket ('search_users:<uid>') with checkout.
--     The Find tab fired one call per keystroke, so typing a few names hit
--     the cap (production rate_limits showed a search_users row at exactly
--     30) and every later call raised 'rate_limited'. The screen swallowed
--     that error and rendered "No matches found".
--
-- This function is the Find tab's own search:
--   * only an ACTIVE representative may call it (the same check
--     invite_recruiter_partnership already makes), so it is not a general
--     user-enumeration endpoint;
--   * returns only users get_recruiter_invite_target would accept:
--     organizer capability or events (recruiter_target_is_organizer, 0196)
--     or an approved service_providers row;
--   * matches anywhere in username or full name, case-insensitively, with
--     LIKE wildcards in the input escaped (usernames contain '_');
--     idx_users_username_trgm / idx_users_full_name_trgm (gin_trgm_ops,
--     already in production) serve these ILIKE '%q%' scans;
--   * returns the same eligibility fields as get_recruiter_invite_target,
--     so the client no longer needs a second lookup to enable Invite;
--   * has its own rate-limit bucket (60/60s), separate from checkout. The
--     client debounces input, so normal typing makes about one call per pause.
--
-- search_users_for_request itself is unchanged (checkout and ticket
-- transfer still use it). No table, policy or financial function is
-- touched.

CREATE OR REPLACE FUNCTION public.search_recruiter_invite_targets(p_query text)
RETURNS TABLE(
  id uuid,
  username text,
  full_name text,
  avatar_url text,
  target_is_organizer boolean,
  target_provider_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  -- A leading '@' is how usernames are displayed everywhere in the app;
  -- people type it.
  v_query   text := NULLIF(ltrim(trim(coalesce(p_query, '')), '@'), '');
  v_escaped text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.recruiters r WHERE r.id = v_uid AND r.status = 'active') THEN
    RAISE EXCEPTION 'Only active representatives can search for partners';
  END IF;

  IF v_query IS NULL OR length(v_query) < 2 THEN
    RETURN;
  END IF;

  v_query := left(v_query, 64);

  PERFORM public.check_rate_limit('recruiter_search:' || v_uid::text, 60, 60);

  -- Escape LIKE metacharacters so '_' and '%' match literally.
  v_escaped := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  SELECT c.id, c.username, c.full_name, c.avatar_url, c.is_org, c.provider_id
    FROM (
      SELECT u.id, u.username, u.full_name, u.avatar_url,
             public.recruiter_target_is_organizer(u.id) AS is_org,
             (SELECT sp.id FROM public.service_providers sp
               WHERE sp.user_id = u.id AND sp.status = 'approved') AS provider_id,
             CASE
               WHEN lower(u.username) = lower(v_query) THEN 0
               WHEN u.username ILIKE v_escaped || '%' ESCAPE '\' THEN 1
               WHEN u.username ILIKE '%' || v_escaped || '%' ESCAPE '\' THEN 2
               ELSE 3
             END AS rank
        FROM public.users u
       WHERE u.deleted_at IS NULL
         AND u.id <> v_uid
         AND u.username IS NOT NULL
         AND (u.username ILIKE '%' || v_escaped || '%' ESCAPE '\'
              OR u.full_name ILIKE '%' || v_escaped || '%' ESCAPE '\')
    ) c
   WHERE c.is_org OR c.provider_id IS NOT NULL
   ORDER BY c.rank, length(c.username), c.username
   LIMIT 20;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_recruiter_invite_targets(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_recruiter_invite_targets(text) TO authenticated;
