-- ============================================================
-- Migration: Highlights Feature
-- ============================================================

-- 1. Create highlights table
CREATE TABLE IF NOT EXISTS public.highlights (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  media_url  TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
  caption    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_highlights_user_id ON public.highlights(user_id);
CREATE INDEX IF NOT EXISTS idx_highlights_created_at ON public.highlights(created_at DESC);

-- 3. RLS
ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;

-- All authenticated users can view highlights
CREATE POLICY "highlights_select_auth"
  ON public.highlights
  FOR SELECT
  TO authenticated
  USING (true);

-- Users can only insert their own highlights
CREATE POLICY "highlights_insert_own"
  ON public.highlights
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Users can only delete their own highlights
CREATE POLICY "highlights_delete_own"
  ON public.highlights
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- 4. Grants
GRANT SELECT, INSERT, DELETE ON public.highlights TO authenticated;
