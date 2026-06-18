-- Add status column to events table
-- Values: 'live' (published, visible) | 'draft' (hidden, organizer-only)
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'live'
    CHECK (status IN ('live', 'draft'));

-- Index for fast filtering by status
CREATE INDEX IF NOT EXISTS idx_events_status ON public.events(status);

-- Update existing events to 'live' (they were all published before)
UPDATE public.events SET status = 'live' WHERE status IS DISTINCT FROM 'live';
