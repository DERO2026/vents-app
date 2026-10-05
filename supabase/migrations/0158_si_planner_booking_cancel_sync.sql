-- P21 ("Booking cancelled on VENTS -> plan auto-reopens the slot") real
-- gap, found during this batch's audit: cancel_service_booking (0077) sets
-- service_bookings.status = 'cancelled' and handles the real refund, but
-- it predates the planner (0156/0157) entirely and never touches
-- plan_assignments -- so a real cancellation left the plan's own
-- plan_assignments row stuck at status='booked' forever, and get_plan
-- would keep reporting a cancelled booking as paid/booked. This is the
-- one real backend gap in the P14-P23 frame group; everything else in
-- that group reuses existing tables/RPCs.
--
-- Minimal, surgical fix: a trigger on service_bookings that, the moment a
-- booking's status flips to 'cancelled', finds any plan_assignments row
-- pointing at it and (a) flips that assignment to 'cancelled' too -- its
-- category becomes unassigned again, read-derived exactly like every
-- other plan_assignments status, never a second source of truth -- and
-- (b) reopens any plan_tasks for that category whose completes_on_booking
-- is true (done_at := NULL), per P17's own spec text ("D. REOPENED BY
-- CHANGE" -- a booking cancellation reopens its tasks and says why).
--
-- SECURITY DEFINER + empty search_path, same convention as every other
-- privileged function in this planner (apply_plan_allocation_changes,
-- assign_plan_provider) -- cancel_service_booking itself runs as whichever
-- provider/admin called it, which has no RLS standing on plan_assignments
-- (a different user's plan), so this trigger must bypass RLS to make the
-- sync at all, the same way the planner's own write-path functions do.
CREATE OR REPLACE FUNCTION public.sync_plan_assignment_on_booking_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_category_id uuid;
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.plan_assignments
       SET status = 'cancelled', updated_at = now()
     WHERE booking_id = NEW.id
       AND status <> 'cancelled'
    RETURNING category_id INTO v_category_id;

    IF v_category_id IS NOT NULL THEN
      UPDATE public.plan_tasks
         SET done_at = NULL, updated_at = now()
       WHERE category_id = v_category_id
         AND completes_on_booking = true
         AND done_at IS NOT NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.sync_plan_assignment_on_booking_cancel() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.sync_plan_assignment_on_booking_cancel() TO anon, authenticated, project_admin;

-- AFTER UPDATE (not BEFORE) -- this reacts to the booking's own
-- cancellation already having committed, same as any other side-effect
-- trigger in this codebase; it never changes the service_bookings row
-- itself (only NEW.status is read, never modified here).
CREATE TRIGGER trg_sync_plan_assignment_on_booking_cancel
  AFTER UPDATE ON public.service_bookings
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.sync_plan_assignment_on_booking_cancel();
