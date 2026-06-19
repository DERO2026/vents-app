-- Add cover_url column to users for profile cover/background photo
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS cover_url text;
