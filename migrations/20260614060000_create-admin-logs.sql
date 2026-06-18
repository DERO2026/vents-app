-- Create admin audit log table
CREATE TABLE IF NOT EXISTS public.admin_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID        NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  action       TEXT        NOT NULL,                     -- e.g. 'suspend_user', 'delete_user', 'change_role'
  target_user_id UUID      REFERENCES public.users(id) ON DELETE SET NULL,
  details      JSONB       NOT NULL DEFAULT '{}',        -- arbitrary key/value context
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;

-- Only admins may insert audit rows
CREATE POLICY admin_insert_logs ON public.admin_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- Only admins may read audit rows
CREATE POLICY admin_select_logs ON public.admin_logs
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Append-only: no updates or deletes ever
-- (we simply do not create UPDATE/DELETE policies)

-- Grant
GRANT SELECT, INSERT ON public.admin_logs TO authenticated;

-- ─── User suspend/active status ───────────────────────────────────────────────
-- Add a `status` column to users so admins can suspend accounts.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted'));

-- Allow admin to UPDATE status on any row
-- The existing admin_update_users policy already covers this via public.is_admin(),
-- so no additional policy is needed here.
