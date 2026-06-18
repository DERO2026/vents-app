-- Create notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('reminder', 'booking', 'promo', 'social')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT false,
  icon TEXT NOT NULL DEFAULT '🔔',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on notifications
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Add policies for notifications
CREATE POLICY select_notifications ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY update_notifications ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY insert_notifications ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Grant privileges on notifications
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;

-- Create security definer check for admin role (prevents recursion)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$;

-- Drop existing users update policy
DROP POLICY IF EXISTS update_users ON public.users;

-- Policy for regular user self-profile updates
CREATE POLICY update_own_user ON public.users
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND (role IS NULL OR role = 'user' OR role = 'attendee' OR role = 'organizer'));

-- Policy for admin profile updates
CREATE POLICY admin_update_users ON public.users
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Grant update to authenticated users so they can perform role toggle or admin operations
GRANT UPDATE ON public.users TO authenticated;
