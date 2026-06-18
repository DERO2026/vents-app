-- follows: attendees following organizers
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organizer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, organizer_id)
);

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can see follows (needed for follower counts)
CREATE POLICY "follows_select" ON public.follows
  FOR SELECT TO authenticated USING (true);

-- Users can only insert their own follow rows
CREATE POLICY "follows_insert" ON public.follows
  FOR INSERT TO authenticated
  WITH CHECK (follower_id = auth.uid());

-- Users can only delete their own follow rows
CREATE POLICY "follows_delete" ON public.follows
  FOR DELETE TO authenticated USING (follower_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.follows TO authenticated;