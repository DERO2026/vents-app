-- Allow admin to read all user rows (needed for Admin Dashboard user search)
CREATE POLICY admin_select_users ON public.users
  FOR SELECT
  USING (public.is_admin());
