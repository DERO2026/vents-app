-- Create follows table
CREATE TABLE IF NOT EXISTS public.follows (
  follower_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id)
);

-- Enable RLS
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- Select policy: anyone can read follows
CREATE POLICY select_follows ON public.follows
  FOR SELECT TO anon, authenticated
  USING (true);

-- Insert policy: authenticated users can follow others as themselves
CREATE POLICY insert_follows ON public.follows
  FOR INSERT TO authenticated
  WITH CHECK (follower_id = (SELECT auth.uid()));

-- Delete policy: authenticated users can unfollow others
CREATE POLICY delete_follows ON public.follows
  FOR DELETE TO authenticated
  USING (follower_id = (SELECT auth.uid()));

-- Grant permissions to authenticated users
GRANT SELECT, INSERT, DELETE ON public.follows TO authenticated;
