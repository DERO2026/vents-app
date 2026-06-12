-- 1. Create users table
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'attendee', 'organizer', 'admin')),
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger function to automatically create a profile in public.users when auth.users is populated
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, role, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.profile->>'name', NEW.profile->>'full_name'),
    COALESCE(NEW.profile->>'role', 'user'),
    NEW.profile->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Trigger to hook into auth.users insert
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 2. Create events table
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  location TEXT NOT NULL,
  event_date TIMESTAMPTZ NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0 CHECK (price >= 0),
  category TEXT,
  organizer_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create tickets table (bookings)
CREATE TABLE IF NOT EXISTS public.tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Create saved_events table
CREATE TABLE IF NOT EXISTS public.saved_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_saved_event UNIQUE (user_id, event_id)
);

-- 5. Create event_promotions table
CREATE TABLE IF NOT EXISTS public.event_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  organizer_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('featured', 'trending', 'boosted')),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired', 'pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_organizer_id ON public.events(organizer_id);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON public.events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_category ON public.events(category);

CREATE INDEX IF NOT EXISTS idx_tickets_event_id ON public.tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON public.tickets(user_id);

CREATE INDEX IF NOT EXISTS idx_saved_events_user_id ON public.saved_events(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_events_event_id ON public.saved_events(event_id);

CREATE INDEX IF NOT EXISTS idx_event_promotions_event_id ON public.event_promotions(event_id);
CREATE INDEX IF NOT EXISTS idx_event_promotions_organizer_id ON public.event_promotions(organizer_id);

-- Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_promotions ENABLE ROW LEVEL SECURITY;

-- Users RLS Policies
CREATE POLICY select_users ON public.users
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY update_users ON public.users
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- Events RLS Policies
CREATE POLICY select_events ON public.events
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY insert_events ON public.events
  FOR INSERT TO authenticated
  WITH CHECK (organizer_id = (SELECT auth.uid()));

CREATE POLICY update_events ON public.events
  FOR UPDATE TO authenticated
  USING (organizer_id = (SELECT auth.uid()))
  WITH CHECK (organizer_id = (SELECT auth.uid()));

CREATE POLICY delete_events ON public.events
  FOR DELETE TO authenticated
  USING (organizer_id = (SELECT auth.uid()));

-- Tickets RLS Policies
CREATE POLICY select_tickets ON public.tickets
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid()) OR
    event_id IN (SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid()))
  );

CREATE POLICY insert_tickets ON public.tickets
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY update_tickets ON public.tickets
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT auth.uid()) OR
    event_id IN (SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    user_id = (SELECT auth.uid()) OR
    event_id IN (SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid()))
  );

-- Saved Events RLS Policies
CREATE POLICY select_saved_events ON public.saved_events
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY insert_saved_events ON public.saved_events
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY delete_saved_events ON public.saved_events
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Event Promotions RLS Policies
CREATE POLICY select_event_promotions ON public.event_promotions
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY insert_event_promotions ON public.event_promotions
  FOR INSERT TO authenticated
  WITH CHECK (
    organizer_id = (SELECT auth.uid()) AND
    event_id IN (SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid()))
  );

CREATE POLICY update_event_promotions ON public.event_promotions
  FOR UPDATE TO authenticated
  USING (organizer_id = (SELECT auth.uid()))
  WITH CHECK (organizer_id = (SELECT auth.uid()));

CREATE POLICY delete_event_promotions ON public.event_promotions
  FOR DELETE TO authenticated
  USING (organizer_id = (SELECT auth.uid()));

-- Privileges and Grants
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Users grants (users cannot update their own role via Client SDK)
GRANT SELECT ON public.users TO anon, authenticated;
GRANT UPDATE (full_name, avatar_url) ON public.users TO authenticated;

-- Events grants
GRANT SELECT ON public.events TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.events TO authenticated;

-- Tickets grants
GRANT SELECT, INSERT, UPDATE ON public.tickets TO authenticated;

-- Saved Events grants
GRANT SELECT, INSERT, DELETE ON public.saved_events TO authenticated;

-- Event Promotions grants
GRANT SELECT ON public.event_promotions TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.event_promotions TO authenticated;
