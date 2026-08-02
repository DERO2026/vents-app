-- Multi-day event support. event_date already carries the start
-- date+time; end_date is the full end date+time and stays NULL for a
-- single-day event (the existing common case) — end_time alone already
-- covers a same-day closing time, this only matters when the event spans
-- into a later calendar day.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;

-- A multi-day event's end can't be before its own start.
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_end_date_after_start;
ALTER TABLE events
  ADD CONSTRAINT events_end_date_after_start CHECK (end_date IS NULL OR end_date >= event_date);
