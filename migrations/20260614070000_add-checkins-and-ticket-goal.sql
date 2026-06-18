-- ─── Check-ins table ─────────────────────────────────────────────────────────
-- Stores one row per successful QR scan (unique per ticket → prevents re-entry)
CREATE TABLE IF NOT EXISTS public.checkins (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID        NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  event_id      UUID        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  scanned_by    UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_checkin UNIQUE (ticket_id)
);

-- Enable RLS
ALTER TABLE public.checkins ENABLE ROW LEVEL SECURITY;

-- Organizers may INSERT check-ins for their own events
CREATE POLICY organizer_insert_checkins ON public.checkins
  FOR INSERT TO authenticated
  WITH CHECK (
    event_id IN (
      SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid())
    )
  );

-- Organizers may SELECT check-ins for their own events
CREATE POLICY organizer_select_checkins ON public.checkins
  FOR SELECT TO authenticated
  USING (
    event_id IN (
      SELECT id FROM public.events WHERE organizer_id = (SELECT auth.uid())
    )
    OR scanned_by = (SELECT auth.uid())
  );

-- Ticket owners may see their own check-in status
CREATE POLICY owner_select_checkins ON public.checkins
  FOR SELECT TO authenticated
  USING (
    ticket_id IN (
      SELECT id FROM public.tickets WHERE user_id = (SELECT auth.uid())
    )
  );

GRANT SELECT, INSERT ON public.checkins TO authenticated;

-- ─── Ticket goal column on events ─────────────────────────────────────────────
-- Allows organizers to set a sales target for the analytics chart
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS ticket_goal INTEGER NOT NULL DEFAULT 500;

-- ─── Performance index for check-ins ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_checkins_event_id  ON public.checkins(event_id);
CREATE INDEX IF NOT EXISTS idx_checkins_ticket_id ON public.checkins(ticket_id);
