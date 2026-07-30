-- Location picker (Google Places) needs coordinates to store the pin the
-- organizer drops/confirms, separate from the existing free-text `location`
-- string which stays as the human-readable display address.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;
