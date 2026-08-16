-- Organizer's "Show Contact Number" toggle (Step 3 of event creation) was
-- being collected in the UI but discarded — no column existed to persist it.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS show_phone BOOLEAN NOT NULL DEFAULT false;
