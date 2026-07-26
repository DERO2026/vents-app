-- ── Stop trusting the client for the 18+ content filter ──────────────────────
-- Audit finding: search_events_fuzzy took p_exclude_18_plus as a plain client-
-- supplied boolean (HomeScreen.tsx computed it from currentUser.date_of_birth
-- in the browser and just sent the result). Any direct RPC call -- or a
-- tampered client -- could pass p_exclude_18_plus: false regardless of the
-- caller's real age, bypassing the minor-content filter entirely.
--
-- Fix: ignore the client-supplied value and derive it server-side from the
-- CALLER'S OWN authenticated row (auth.uid() -> users.date_of_birth). If
-- there's no authenticated user (anon) or no date_of_birth on file, default
-- to EXCLUDING 18+ content (fail closed) rather than trusting anything from
-- the client. The parameter is kept in the signature for backward
-- compatibility with the existing client call -- it's simply unused now.

CREATE OR REPLACE FUNCTION public.search_events_fuzzy(
  p_query text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_exclude_18_plus boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  image_url text,
  location text,
  event_date timestamptz,
  price numeric,
  category text,
  categories text[],
  organizer_id uuid,
  created_at timestamptz,
  ticket_types jsonb,
  ticket_goal integer,
  is_featured boolean,
  featured_until timestamptz,
  is_18_plus boolean,
  organizer_name text,
  organizer_vc_badge text,
  match_score real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_words text[];
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
  v_dob date;
  v_exclude_18_plus boolean;
BEGIN
  SELECT array_agg(DISTINCT w) INTO v_words
  FROM unnest(regexp_split_to_array(unaccent(lower(trim(coalesce(p_query, '')))), '\s+')) AS w
  WHERE w <> '';

  IF v_words IS NULL OR array_length(v_words, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Server-derived, not client-supplied: no session, no date_of_birth on
  -- file, or under 18 all fail closed to "exclude".
  IF auth.uid() IS NULL THEN
    v_exclude_18_plus := true;
  ELSE
    SELECT date_of_birth INTO v_dob FROM public.users WHERE id = auth.uid();
    v_exclude_18_plus := v_dob IS NULL OR date_part('year', age(v_dob)) < 18;
  END IF;

  RETURN QUERY
  SELECT
    e.id, e.title, e.description, e.image_url, e.location, e.event_date,
    e.price, e.category, e.categories, e.organizer_id, e.created_at,
    e.ticket_types, e.ticket_goal, e.is_featured, e.featured_until, e.is_18_plus,
    COALESCE(u.username, u.full_name) AS organizer_name,
    u.vc_badge AS organizer_vc_badge,
    m.score AS match_score
  FROM public.events e
  LEFT JOIN public.users u ON u.id = e.organizer_id
  CROSS JOIN LATERAL (
    SELECT unaccent(lower(
      e.title || ' ' || coalesce(e.location, '') || ' ' || coalesce(e.category, '') || ' ' ||
      array_to_string(coalesce(e.categories, ARRAY[]::text[]), ' ') || ' ' ||
      coalesce(u.username, '') || ' ' || coalesce(u.full_name, '')
    )) AS haystack
  ) hay
  CROSS JOIN LATERAL (
    SELECT
      bool_and(per_word.matched) AS all_words_matched,
      avg(per_word.best_score)::real AS score
    FROM (
      SELECT
        EXISTS (
          SELECT 1 FROM (
            SELECT w AS term
            UNION
            SELECT s.synonym FROM public.search_synonyms s WHERE s.term = w
          ) expanded
          WHERE hay.haystack ILIKE '%' || expanded.term || '%'
             OR word_similarity(expanded.term, hay.haystack) > 0.35
        ) AS matched,
        GREATEST(
          (
            SELECT MAX(word_similarity(expanded.term, hay.haystack))
            FROM (
              SELECT w AS term
              UNION
              SELECT s.synonym FROM public.search_synonyms s WHERE s.term = w
            ) expanded
          ),
          CASE WHEN hay.haystack ILIKE '%' || w || '%' THEN 1.0 ELSE 0.0 END
        ) AS best_score
      FROM unnest(v_words) w
    ) per_word
  ) m
  WHERE e.hidden_by_admin = false
    AND e.deleted_at IS NULL
    AND e.status IN ('live', 'published')
    AND e.event_date >= now()
    AND (NOT v_exclude_18_plus OR e.is_18_plus = false)
    AND m.all_words_matched
  ORDER BY m.score DESC, e.is_featured DESC, e.event_date ASC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;
