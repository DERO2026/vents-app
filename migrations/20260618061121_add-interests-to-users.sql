ALTER TABLE public.users ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';
