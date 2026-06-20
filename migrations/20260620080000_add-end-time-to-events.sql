-- Add start_time and end_time text columns to events table.
-- event_date stores the date; these store the human-readable time strings (e.g. "7:00 PM").
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS start_time text,
  ADD COLUMN IF NOT EXISTS end_time   text;
