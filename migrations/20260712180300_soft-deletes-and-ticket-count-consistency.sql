-- Data Consistency phase.
--
-- 1. SOFT DELETES: events had NO deleted_at/deleted_by/reason columns at
--    all, and ManageEventsScreen.tsx's organizer "Delete Event" action did
--    a raw hard `DELETE FROM events`. Combined with
--    tickets_event_id_fkey being ON DELETE CASCADE, a single click by any
--    organizer permanently destroyed every ticket/payment/check-in record
--    for that event -- including paid transaction history -- with zero
--    recovery path. Fixed by adding soft-delete columns, changing the FK
--    to ON DELETE RESTRICT (so even a future hard-delete attempt is
--    physically blocked while tickets exist), and giving both the
--    organizer and admin a real soft-delete RPC. users already had
--    deleted_at (from an earlier phase) but no deleted_by/reason -- added
--    here so the admin "Delete Account" action (AdminDashboardScreen.tsx
--    handleSoftDelete, currently a raw table UPDATE with no reason
--    capture) can record who deleted an account and why, not just when.
--
-- 2. SINGLE SOURCE OF TRUTH for ticket counts: an audit found five
--    different, independently-drifting query/filter combinations across
--    EventDetailsScreen, SalesAnalyticsScreen, AttendeeListScreen,
--    OrganizerDashboard, and the Home feed, some counting
--    status='active' regardless of payment, some counting
--    payment_status='paid' regardless of status, and App.tsx's "My
--    Tickets" screen reading a column (events.attendee_count) that never
--    existed in any migration -- always silently falling back to 0. A
--    single canonical function replaces all of them: "sold" means
--    status='active' AND payment_status='paid'; pending/cancelled/refunded
--    are reported separately so nothing has to guess.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reason text;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reason text;

-- Defense-in-depth: even if a future bug or manual query attempted a hard
-- DELETE on an event, Postgres itself now refuses while any ticket rows
-- reference it -- soft-delete becomes the only viable path, not just the
-- documented one.
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_event_id_fkey;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE RESTRICT;

-- Soft-deleted events stay invisible to the general public, but the
-- organizer who deleted it (for a future restore) and admins (moderation)
-- can still see it.
DROP POLICY IF EXISTS select_events ON public.events;
CREATE POLICY select_events ON public.events
  FOR SELECT
  USING (deleted_at IS NULL OR organizer_id = (SELECT auth.uid()) OR public.is_admin());

CREATE OR REPLACE FUNCTION public.soft_delete_event(p_event_id uuid, p_reason text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_owner   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organizer_id INTO v_owner FROM public.events WHERE id = p_event_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner <> v_user_id AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'You do not have permission to delete this event';
  END IF;

  UPDATE public.events
     SET deleted_at = now(),
         deleted_by = v_user_id,
         reason = p_reason,
         status = 'draft'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_user_id, 'delete_event',
          jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
          public.actor_role());
END;
$function$;

-- Admin-only safety net symmetric with admin_reinstate_event (which only
-- ever handled hidden_by_admin, a separate moderation concept from an
-- actual delete).
CREATE OR REPLACE FUNCTION public.admin_restore_deleted_event(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  UPDATE public.events
     SET deleted_at = NULL, deleted_by = NULL, reason = NULL, status = 'live'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'restore_event', jsonb_build_object('event_id', p_event_id), public.actor_role());
END;
$function$;

-- Single source of truth for "tickets sold" / attendee counts. Accepts an
-- array so both single-event screens (EventDetailsScreen) and bulk
-- screens (Home feed cards, SalesAnalyticsScreen, OrganizerDashboard) can
-- call the exact same definition in one round trip instead of each
-- re-implementing its own filter. SECURITY DEFINER because this needs to
-- return an aggregate for events the caller doesn't own (any visitor
-- viewing a public event page needs to see "127 attending") without
-- exposing individual ticket/attendee rows, which tickets' own RLS
-- correctly restricts to the ticket holder/organizer/admin.
CREATE OR REPLACE FUNCTION public.get_event_ticket_stats(p_event_ids uuid[])
 RETURNS TABLE (
   event_id uuid,
   sold_count integer,
   sold_quantity integer,
   pending_count integer,
   cancelled_count integer,
   refunded_count integer,
   revenue_kobo bigint
 )
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
AS $function$
  SELECT
    t.event_id,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid')::integer AS sold_count,
    COALESCE(sum(t.quantity) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::integer AS sold_quantity,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'pending')::integer AS pending_count,
    count(*) FILTER (WHERE t.status = 'cancelled' AND t.payment_status <> 'refunded')::integer AS cancelled_count,
    count(*) FILTER (WHERE t.payment_status = 'refunded')::integer AS refunded_count,
    COALESCE(sum(t.amount * 100) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::bigint AS revenue_kobo
  FROM public.tickets t
  WHERE t.event_id = ANY(p_event_ids)
  GROUP BY t.event_id;
$function$;

GRANT EXECUTE ON FUNCTION public.get_event_ticket_stats(uuid[]) TO anon, authenticated;
