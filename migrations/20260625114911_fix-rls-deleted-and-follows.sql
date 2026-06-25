-- Task 3: Fix RLS on deleted_emails, deleted_phones, and follows anon exposure.

-- Enable RLS on deleted_emails (issue 20)
ALTER TABLE public.deleted_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY "admin_only" ON public.deleted_emails
  FOR ALL TO authenticated
  USING (public.is_admin());

-- Fix deleted_phones (issue 6) — RLS enabled but no policies defined
CREATE POLICY "admin_only" ON public.deleted_phones
  FOR ALL TO authenticated
  USING (public.is_admin());

-- Fix follows anon read (issue 2) — remove anon access, keep authenticated
DROP POLICY IF EXISTS "select_follows" ON public.follows;
CREATE POLICY "select_follows" ON public.follows
  FOR SELECT TO authenticated
  USING (true);
