-- Allow any authenticated user to log their own organizer promotion.
-- The existing admin_insert_logs policy blocks non-admins, so we add a
-- narrow self-service policy: inserter must be the target, action must be
-- 'organizer_promoted', and the user's current role must be 'organizer'.

CREATE POLICY self_organizer_promotion_log ON public.admin_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    action = 'organizer_promoted'
    AND admin_id = auth.uid()
    AND target_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('organizer', 'organiser')
    )
  );
