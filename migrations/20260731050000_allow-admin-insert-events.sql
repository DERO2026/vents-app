-- insert_events required auth.uid() = organizer_id with no admin bypass,
-- while select/update/delete on events all already allow is_admin(). The
-- Admin Import flow inserts events attributed to a fixed placeholder
-- organizer ("ventsofficial", dfca505f-b2f6-449f-aa86-f7e7ece7d1dc) rather
-- than the admin's own uid, so every import publish hit this RLS gap and
-- failed with "new row violates row-level security policy for table
-- events" — the feature could never have worked for any admin other than
-- that exact placeholder account signing in directly.
DROP POLICY IF EXISTS insert_events ON public.events;
CREATE POLICY insert_events ON public.events
  FOR INSERT
  WITH CHECK (auth.uid() = organizer_id OR is_admin());
