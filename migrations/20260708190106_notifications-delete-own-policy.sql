-- Allow users to delete their own notifications (e.g. "Clear notification
-- history" in Settings). No DELETE policy existed before this, so RLS
-- default-denied any delete attempt regardless of ownership.
CREATE POLICY delete_notifications ON public.notifications
  FOR DELETE
  USING (user_id = (SELECT auth.uid()));
