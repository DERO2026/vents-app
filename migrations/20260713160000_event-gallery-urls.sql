-- Multi-flier support: events previously only had a single image_url
-- (cover). Additional fliers go in this array; image_url stays the
-- primary/cover image shown everywhere else in the app unchanged.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS gallery_urls text[] NOT NULL DEFAULT '{}'::text[];
