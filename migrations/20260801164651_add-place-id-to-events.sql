-- Google Places ID for the event's venue, captured by LocationPicker when
-- an organizer selects a place from the autocomplete dropdown (Prompt 3 —
-- Native Location Search). Purely additive/nullable — existing events keep
-- working with lat/lng + the composite `location` string exactly as
-- before; place_id is a forward-looking identifier for richer Places
-- lookups later (fresh place details, photos, ratings) without needing to
-- re-geocode the venue from its address string.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS place_id text;
