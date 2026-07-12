-- Zero-trust gap found during Phase 3 audit: two separate issues on the
-- events table.
--
-- 1. is_featured/featured_until: PromoteEventScreen.tsx wrote these
--    directly from the browser inside the Paystack popup's onSuccess
--    callback, trusting the CLIENT's report that payment succeeded --
--    exactly the same "trust the popup" flaw already fixed for ticket
--    purchases (purchase_ticket/confirm_ticket_payment) earlier this
--    session, just never applied here. Worse, because update_events RLS
--    has no column restriction, an organizer didn't even need the popup --
--    a single direct table write granted a free "Featured Campaign"
--    (worth up to NGN80,000) with zero payment.
--
-- 2. hidden_by_admin: ManageEventsScreen.tsx's organizer-facing "Hide
--    Event" toggle wrote this column directly too, meaning an organizer
--    whose event was hidden by an admin for a violation could simply
--    click "Make Live" on their own Manage Events screen and undo the
--    admin's moderation action. The organizer's actual "pause my own
--    event" self-service need is already fully served by the `status`
--    column (the public feed query already filters
--    `.in('status', ['live','published'])` independent of
--    hidden_by_admin) -- so hidden_by_admin can become admin/RPC-only
--    with no loss of legitimate organizer functionality.
CREATE OR REPLACE FUNCTION public.protect_event_promotion_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_featured IS DISTINCT FROM NEW.is_featured THEN
    RAISE EXCEPTION 'is_featured can only be changed via activate_event_promotion()';
  END IF;
  IF OLD.featured_until IS DISTINCT FROM NEW.featured_until THEN
    RAISE EXCEPTION 'featured_until can only be changed via activate_event_promotion()';
  END IF;
  IF OLD.hidden_by_admin IS DISTINCT FROM NEW.hidden_by_admin THEN
    RAISE EXCEPTION 'hidden_by_admin can only be changed by an admin';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_event_promotion_columns ON public.events;
CREATE TRIGGER trg_protect_event_promotion_columns
  BEFORE UPDATE OF is_featured, featured_until, hidden_by_admin ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.protect_event_promotion_columns();

-- Admin's hide/reinstate actions already go through the existing
-- admin_hide_event()/admin_reinstate_event() RPCs (both SECURITY DEFINER
-- with their own is_admin() check and admin_logs audit row), so they
-- already bypass the trigger above via the same current_user <>
-- 'authenticated' pattern -- no new RPC needed for the admin path.

-- Idempotency: the same Paystack reference can only ever activate one
-- promotion, closing the replay path (retrying with an already-used
-- reference) the same way payment_ref uniqueness does for tickets.
-- Plain (non-partial) unique index: ON CONFLICT (payment_ref) below needs
-- an index it can infer against, which a partial index can't satisfy
-- without repeating its WHERE clause in the ON CONFLICT target. A plain
-- unique index still allows multiple NULLs (Postgres's standard behavior),
-- so this doesn't need to be partial anyway.
ALTER TABLE public.event_promotions ADD COLUMN IF NOT EXISTS payment_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_promotions_payment_ref ON public.event_promotions (payment_ref);

-- Server-verified promotion activation. Called only after the caller's
-- Paystack payment reference has been independently confirmed successful
-- and for the correct amount by api/promotions/activate.ts (which holds
-- PAYSTACK_SECRET_KEY and can call Paystack's verify-transaction API --
-- something this SQL function cannot do itself). This RPC re-checks event
-- ownership itself rather than trusting the caller, and is idempotent on
-- payment_ref so a duplicate call (retry, double-tap) is a no-op.
CREATE OR REPLACE FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_owner_id uuid;
  v_end_date timestamptz;
  v_inserted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_plan_type NOT IN ('boosted', 'featured', 'trending') THEN
    RAISE EXCEPTION 'Invalid plan_type';
  END IF;
  IF p_duration_days NOT IN (3, 7, 14, 30) THEN
    RAISE EXCEPTION 'Invalid duration';
  END IF;
  IF p_payment_ref IS NULL OR trim(p_payment_ref) = '' THEN
    RAISE EXCEPTION 'payment_ref is required';
  END IF;

  SELECT organizer_id INTO v_owner_id FROM public.events WHERE id = p_event_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner_id <> v_user_id THEN
    RAISE EXCEPTION 'You do not own this event';
  END IF;

  v_end_date := now() + make_interval(days => p_duration_days);

  INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status, payment_ref)
  VALUES (p_event_id, v_user_id, p_plan_type, now(), v_end_date, 'active', p_payment_ref)
  ON CONFLICT (payment_ref) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN; -- replayed reference — already activated, no-op
  END IF;

  IF p_plan_type IN ('featured', 'trending') THEN
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  END IF;
END;
$function$;
