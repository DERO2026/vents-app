-- Adds a structured country field to events, for Home/event-discovery
-- default-country filtering. Audit first: events.location is a single
-- free-text column ("venue, stateName, city[, address]", parsed
-- client-side by mapDbEventToFrontend in HomeScreen.tsx) with no
-- structured country anywhere -- no country/state/city columns exist on
-- events at all. Per instruction, NOT doing substring matching against
-- that text; adding the smallest proper structured field instead.
--
-- Backfilled 'NG' for existing rows -- VENTS launched Nigeria-only, so
-- every event created before this column existed genuinely was a
-- Nigerian event; this is an accurate historical fact, not an invented
-- default, same reasoning as 0037's organizer_verification_requests
-- backfill. New events (via the updated CreateEventScreen) will always
-- pass their own explicit country going forward.
--
-- Does NOT touch select_events or any other RLS policy -- country is
-- discovery-default metadata, never an access/visibility restriction
-- (matches the same non-negotiable already established for
-- users.country and service_providers.country).

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'NG';

ALTER TABLE public.events
  ADD CONSTRAINT events_country_format_check CHECK (country ~ '^[A-Z]{2}$');

CREATE INDEX IF NOT EXISTS idx_events_country ON public.events (country);
