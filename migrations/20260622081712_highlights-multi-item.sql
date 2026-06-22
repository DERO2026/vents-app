-- Add group_id and sort_order to highlights for multi-item support.
-- group_id groups multiple media items under one highlight circle.
-- Rows with the same group_id form one highlight; sort_order = 0 is the cover.
-- Existing single-item highlights: assign each its own group_id so it still shows as a circle.

ALTER TABLE public.highlights
  ADD COLUMN IF NOT EXISTS group_id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

-- Backfill existing rows: each gets a unique group_id (already done by DEFAULT gen_random_uuid())
-- so they each remain their own highlight circle.

-- Index for efficient group lookups
CREATE INDEX IF NOT EXISTS idx_highlights_group_id ON public.highlights(group_id);
CREATE INDEX IF NOT EXISTS idx_highlights_user_group ON public.highlights(user_id, group_id, sort_order);
