-- search_events_fuzzy built ILIKE patterns as '%' || term || '%' with no
-- escaping — a search term containing a literal '%' or '_' was interpreted
-- as a SQL wildcard rather than a literal character (e.g. searching "50%
-- off" matches anything, and "a_b" matches "axb"). Low severity (no
-- injection risk — this is Postgres's own LIKE wildcard semantics, not SQL
-- injection), but produces surprising/wrong results for anyone searching
-- literal punctuation. Escapes '\', '%', and '_' before building the
-- pattern, using the standard ESCAPE '\' clause.
CREATE OR REPLACE FUNCTION public.search_events_fuzzy(p_query text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_exclude_18_plus boolean DEFAULT false)
 RETURNS TABLE(id uuid, title text, description text, image_url text, location text, event_date timestamp with time zone, price numeric, category text, categories text[], organizer_id uuid, created_at timestamp with time zone, ticket_types jsonb, ticket_goal integer, is_featured boolean, featured_until timestamp with time zone, is_18_plus boolean, organizer_name text, organizer_vc_badge text, match_score real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
    -- Critical, currently-live bug found while fixing the ILIKE escaping
    -- below: `WHERE id = auth.uid()` is ambiguous — this function's
    -- RETURNS TABLE declares an output column also named `id`, which
    -- PL/pgSQL treats as an in-scope variable throughout the function
    -- body. Since the anon key's own JWT carries a placeholder `sub`
    -- claim, auth.uid() is non-null for virtually every caller (not just
    -- logged-in users), so this ELSE branch — and this exact ambiguity
    -- error — fired for nearly every search request. Live-confirmed: the
    -- unqualified version threw 42702 "column reference \"id\" is
    -- ambiguous" via the REST RPC even with the anon key.
    SELECT date_of_birth INTO v_dob FROM public.users WHERE public.users.id = auth.uid();
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
          WHERE hay.haystack ILIKE '%' || replace(replace(replace(expanded.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
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
          CASE WHEN hay.haystack ILIKE '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\' THEN 1.0 ELSE 0.0 END
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
