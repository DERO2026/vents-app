-- ============================================================
-- Migration: Root Access, Verification System & App Config
-- ============================================================

-- 1. Add is_verified to users table
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;

-- 2. Seed: the root 'vents' account is always verified
UPDATE public.users
  SET is_verified = true
  WHERE id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

-- 3. Create app_config table (single-row singleton for global settings)
CREATE TABLE IF NOT EXISTS public.app_config (
  id            BOOLEAN PRIMARY KEY DEFAULT true CHECK (id = true), -- enforce single row
  maintenance_mode BOOLEAN NOT NULL DEFAULT false,
  broadcast_message TEXT,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  updated_by    UUID REFERENCES public.users(id)
);

-- Seed with defaults
INSERT INTO public.app_config (id, maintenance_mode)
  VALUES (true, false)
  ON CONFLICT (id) DO NOTHING;

-- 4. RLS helper: is_root() — checks if the current user is the root UID
CREATE OR REPLACE FUNCTION public.is_root()
  RETURNS BOOLEAN
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
AS $$
  SELECT auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid;
$$;

-- 5. RLS helper: is_admin_or_root()
CREATE OR REPLACE FUNCTION public.is_admin_or_root()
  RETURNS BOOLEAN
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
AS $$
  SELECT (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
    OR public.is_root()
  );
$$;

-- 6. Enable RLS on app_config
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to READ app_config (for maintenance mode check)
CREATE POLICY "app_config_read_all"
  ON public.app_config
  FOR SELECT
  TO authenticated
  USING (true);

-- Only root can UPDATE app_config
CREATE POLICY "app_config_root_update"
  ON public.app_config
  FOR UPDATE
  TO authenticated
  USING (public.is_root())
  WITH CHECK (public.is_root());

-- 7. Grant select on app_config to authenticated
GRANT SELECT ON public.app_config TO authenticated;
GRANT UPDATE ON public.app_config TO authenticated;

-- 8. Ensure admin_logs exists (already created but guard with IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS public.admin_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       UUID REFERENCES public.users(id),
  action         TEXT NOT NULL,
  target_user_id UUID REFERENCES public.users(id),
  details        JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Index for fast admin_id and action lookups
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON public.admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON public.admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON public.admin_logs(created_at DESC);
