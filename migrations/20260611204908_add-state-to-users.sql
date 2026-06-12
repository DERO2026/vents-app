-- Alter users table to add state
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS state TEXT;

-- Update trigger function to handle username, phone_number and state from NEW.profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, role, avatar_url, username, phone_number, state)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.profile->>'name', NEW.profile->>'full_name'),
    COALESCE(NEW.profile->>'role', 'user'),
    NEW.profile->>'avatar_url',
    NEW.profile->>'username',
    NEW.profile->>'phone_number',
    NEW.profile->>'state'
  )
  ON CONFLICT (id) DO UPDATE
  SET
    username = EXCLUDED.username,
    phone_number = EXCLUDED.phone_number,
    state = EXCLUDED.state;
  RETURN NEW;
END;
$$;

-- Grant updates to authenticated users
GRANT UPDATE (full_name, avatar_url, username, phone_number, state) ON public.users TO authenticated;
