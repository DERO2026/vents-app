-- Allow admins to insert events on behalf of any organizer (e.g. import tool)
DROP POLICY IF EXISTS insert_events ON public.events;

CREATE POLICY insert_events ON public.events
  FOR INSERT
  WITH CHECK (
    (organizer_id = auth.uid() AND is_organizer())
    OR is_admin()
  );