-- Real provider star ratings for the redesign's provider cards (Home +
-- Services), aggregated from provider_reviews (0054) -- a review only
-- exists there after a genuine paid VENTS booking (provider_reviews_
-- insert_own's own gate), so this average is never fabricated/inflatable
-- client-side. A plain view, not a table: provider_reviews' own RLS
-- (provider_reviews_public_select, "USING (true)" -- reviews are already
-- fully public) is what actually governs visibility here, same as
-- querying the underlying rows directly; the view adds no new exposure,
-- it only pre-aggregates.
CREATE OR REPLACE VIEW public.service_provider_ratings AS
SELECT
  provider_id,
  ROUND(AVG(rating)::numeric, 1) AS avg_rating,
  COUNT(*) AS review_count
FROM public.provider_reviews
GROUP BY provider_id;

GRANT SELECT ON public.service_provider_ratings TO anon, authenticated, project_admin;
