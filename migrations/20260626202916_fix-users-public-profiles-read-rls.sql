-- Allow authenticated users to read all user rows (needed for vc_badge, avatar_url, etc.)
-- The existing update policies (update_own_user, admin_update_users) still restrict writes.
DROP POLICY IF EXISTS "public_profiles_read" ON public.users;
CREATE POLICY "public_profiles_read" ON public.users
  FOR SELECT TO authenticated USING (true);
