-- Add bio column to public.users
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Update trigger function to also set bio
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, role, avatar_url, username, phone_number, bio)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.profile->>'name', NEW.profile->>'full_name'),
    COALESCE(NEW.profile->>'role', 'user'),
    NEW.profile->>'avatar_url',
    NEW.profile->>'username',
    NEW.profile->>'phone_number',
    NEW.profile->>'bio'
  )
  ON CONFLICT (id) DO UPDATE
  SET
    username = EXCLUDED.username,
    phone_number = EXCLUDED.phone_number,
    bio = EXCLUDED.bio;
  RETURN NEW;
END;
$$;

-- Grant updates to authenticated users
GRANT UPDATE (full_name, avatar_url, username, phone_number, bio) ON public.users TO authenticated;
