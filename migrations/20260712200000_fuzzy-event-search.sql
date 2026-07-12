-- Block 18: Search Optimization.
--
-- The Explore feed's search was pure client-side .includes() filtering over
-- whatever page of events happened to already be loaded (HomeScreen.tsx) --
-- no server-side query, no typo tolerance, no synonyms, and it could never
-- surface a match that hadn't been paginated in yet. This migration adds a
-- real server-side fuzzy search RPC covering venues/cities (both embedded in
-- events.location), categories, and artists (proxied by the organizer's
-- display name -- the schema has no dedicated artist column).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Trigram indexes accelerate both the ILIKE '%term%' partial-match branch
-- and the word_similarity() typo-tolerance branch below.
CREATE INDEX IF NOT EXISTS idx_events_title_trgm ON public.events USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_location_trgm ON public.events USING gin (location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_events_category_trgm ON public.events USING gin (category gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON public.users USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm ON public.users USING gin (full_name gin_trgm_ops);

-- Small domain-synonym lookup so a search for one term also catches events
-- tagged/titled under its synonym (e.g. "gig" <-> "concert").
CREATE TABLE IF NOT EXISTS public.search_synonyms (
  term text PRIMARY KEY,
  synonym text NOT NULL
);

INSERT INTO public.search_synonyms (term, synonym) VALUES
  ('gig', 'concert'), ('concert', 'gig'),
  ('show', 'concert'),
  ('fest', 'festival'), ('festival', 'fest'),
  ('dj', 'deejay'), ('deejay', 'dj'),
  ('party', 'rave'), ('rave', 'party'), ('clubbing', 'party'), ('owambe', 'party'),
  ('afrobeats', 'afrobeat'), ('afrobeat', 'afrobeats'),
  ('standup', 'comedy'), ('comedy', 'standup'),
  ('expo', 'exhibition'), ('exhibition', 'expo'),
  ('seminar', 'conference'), ('conference', 'seminar'),
  ('bootcamp', 'workshop'), ('workshop', 'bootcamp')
ON CONFLICT (term) DO NOTHING;

-- SECURITY DEFINER: only ever returns the same public event/organizer
-- columns the client can already read via the regular events select, just
-- ranked and matched server-side instead of client-side.
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
BEGIN
  SELECT array_agg(DISTINCT w) INTO v_words
  FROM unnest(regexp_split_to_array(unaccent(lower(trim(coalesce(p_query, '')))), '\s+')) AS w
  WHERE w <> '';

  IF v_words IS NULL OR array_length(v_words, 1) IS NULL THEN
    RETURN;
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
    -- Every query word (or one of its known synonyms) must appear
    -- somewhere in this event's searchable text -- AND across words (so
    -- "lagos fest" narrows to Lagos festivals), OR across a word's
    -- synonym set (so "gig" also catches events tagged "concert"), and
    -- either as a partial substring or a typo-tolerant trigram match.
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
    AND (NOT p_exclude_18_plus OR e.is_18_plus = false)
    AND m.all_words_matched
  ORDER BY m.score DESC, e.is_featured DESC, e.event_date ASC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_events_fuzzy(text, integer, integer, boolean) TO anon, authenticated;
