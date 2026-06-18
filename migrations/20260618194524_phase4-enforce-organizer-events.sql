-- Phase 4: Server-side enforcement — only organizers/admins may create events.
-- The previous insert_events WITH CHECK only verified organizer_id = auth.uid(),
-- which meant any authenticated user could insert an event using their own id.
-- This migration adds a role check so attendees are rejected at the DB level.

-- Helper: returns true if the calling user has an organizer or admin role.
-- SECURITY DEFINER so it can read public.users without RLS recursion.
CREATE OR REPLACE FUNCTION public.is_organizer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('organizer', 'organiser', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_organizer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_organizer() TO authenticated;

-- Update the INSERT policy to require organizer/admin role
DROP POLICY IF EXISTS insert_events ON public.events;
CREATE POLICY insert_events ON public.events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organizer_id = auth.uid()
    AND public.is_organizer()
  );
