-- 0224: Coming Soon events -- discoverable before ticket sales open, with
-- "Notify me" alerts sent once when sales open.
--
-- Existing lifecycle (audited before this change; unchanged by it):
--   * events.status is 'live' or 'draft' (events_status_check, 0005).
--       draft -- private; organizer "Hide as Draft".
--       live  -- public and purchasable.
--   * Ended / completed is DERIVED, not a status: now() >= event_effective_end_at
--     (0051); archived_at is set 7 days later by archive_ended_events.
--   * Cancelled is cancelled_at (0218), set only by an admin-approved
--     cancellation request; a cancelled event can never be put back on sale.
--   * There is no per-event admin approval. What gates publishing is the
--     organizer capability (insert_events requires is_organizer(), 0130;
--     granted by admin approval of an organizer request) and admin hiding
--     (hidden_by_admin, which only an admin can change -- 0182 trigger).
--   * Every ticket-creating function refuses an event whose status is not
--     'live': create_pending_purchase (both overloads), finalize_pending_
--     purchase and purchase_ticket (purchase_ticket_with_tokens wraps it).
--     The precheck below re-verifies this against the database it runs on.
--
-- What this adds:
--   * status 'coming_soon': public and discoverable, NOT purchasable. Because
--     every purchase path already requires status = 'live', a Coming Soon
--     event cannot be bought through any RPC or direct API call -- no money
--     function is changed. Every existing discovery query (homepage feed,
--     Featured, Trending, search_events_fuzzy, related events) filters on
--     status IN ('live','published'), so Coming Soon events never leak into
--     them and are never featured or trending automatically.
--   * events.sales_open_at (timestamptz, UTC like every timestamp here): the
--     planned ticket sales opening. Required for 'coming_soon'; must not be
--     after the event starts.
--   * open_event_sales(event_id): the ONLY way a scheduled event goes live.
--     It keeps the same row (same id, flyer, details, organizer, venue,
--     promotions untouched), refuses before sales_open_at, and in the same
--     transaction delivers one 'event_update' notification to every
--     subscriber not yet notified (push follows from the existing
--     notifications trigger). Called by:
--       - pg_cron every minute (open_due_event_sales); 0224 enables pg_cron
--         and refuses to apply if it cannot (see the end of this file);
--       - the Vercel daily cron (api/cron/run.ts) as a backstop;
--       - the app, lazily, when someone views a Coming Soon event whose time
--         has passed -- so a missed or delayed job heals itself.
--     A delayed job only opens sales LATE, never early.
--   * event_sale_alerts: "Notify me" subscriptions, one row per (event,
--     user). Users read only their own rows; organizers see counts only.
--     notified_at makes delivery exactly-once: a row is marked and its
--     notification written in one statement, inside the transaction that
--     opens sales.
--   * events_sales_schedule_guard (trigger). Privileged writes that set a
--     scheduled event live without going through open_event_sales (e.g.
--     admin_restore_deleted_event) keep it Coming Soon. Client writes:
--       - a scheduled event cannot be set 'live' directly (so sales cannot
--         open early and subscribers are never skipped); use open_event_sales;
--       - a sales time can only be moved to another future time, never
--         cleared, and is frozen once sales are open;
--       - 'coming_soon' requires the organizer capability (or admin), a
--         future sales time, an event that was never on sale with tickets,
--         and an event that is not cancelled.
--
-- Unchanged: purchase/checkout functions, fees, Paystack, wallets,
-- promotions (activate_event_promotion), admin hiding, cancellation,
-- archival, RLS on events.
--
-- Production: NOT applied by this change. Apply only with owner approval.
-- Rollback: supabase/rollback/undo_0224.sql.

DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.events') IS NULL OR to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION '0224 requires public.events and public.notifications';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'cancelled_at') THEN
    RAISE EXCEPTION '0224 requires 0218 (events.cancelled_at is missing)';
  END IF;
  IF to_regprocedure('public.is_organizer()') IS NULL OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.check_rate_limit(text,integer,integer)') IS NULL
     OR to_regprocedure('public.event_effective_end_at(timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '0224 requires is_organizer(), is_admin(), check_rate_limit() and event_effective_end_at()';
  END IF;
  -- The checkout protection rests on this: every ticket-creating function
  -- must refuse an event that is not 'live'. Refuse to apply otherwise.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'create_pending_purchase')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'finalize_pending_purchase') THEN
    RAISE EXCEPTION '0224 requires create_pending_purchase and finalize_pending_purchase';
  END IF;
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.prosrc
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('create_pending_purchase', 'finalize_pending_purchase', 'purchase_ticket')
  LOOP
    IF position('status <> ''live''' IN r.prosrc) = 0 THEN
      RAISE EXCEPTION '0224 refused: % does not refuse non-live events; Coming Soon would be purchasable', r.sig;
    END IF;
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.prosrc
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'purchase_ticket_with_tokens'
  LOOP
    IF position('public.purchase_ticket(' IN r.prosrc) = 0 THEN
      RAISE EXCEPTION '0224 refused: % no longer delegates to purchase_ticket', r.sig;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- events: status 'coming_soon' and the planned sales opening
-- ---------------------------------------------------------------------------
ALTER TABLE public.events ADD COLUMN sales_open_at timestamptz;

ALTER TABLE public.events DROP CONSTRAINT events_status_check;
ALTER TABLE public.events ADD CONSTRAINT events_status_check
  CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text, 'coming_soon'::text])));
ALTER TABLE public.events ADD CONSTRAINT events_coming_soon_sales_time
  CHECK (status <> 'coming_soon' OR sales_open_at IS NOT NULL);
ALTER TABLE public.events ADD CONSTRAINT events_sales_open_before_start
  CHECK (sales_open_at IS NULL OR sales_open_at <= event_date);

CREATE INDEX idx_events_coming_soon_due ON public.events (sales_open_at)
  WHERE status = 'coming_soon';

-- ---------------------------------------------------------------------------
-- Notify me subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE public.event_sale_alerts (
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_event_sale_alerts_user ON public.event_sale_alerts (user_id);
CREATE INDEX idx_event_sale_alerts_pending ON public.event_sale_alerts (event_id) WHERE notified_at IS NULL;

ALTER TABLE public.event_sale_alerts ENABLE ROW LEVEL SECURITY;
-- A user sees only their own subscriptions (to show "Notify me" state).
-- Nobody writes the table directly; the functions below do.
CREATE POLICY select_own_event_sale_alerts ON public.event_sale_alerts
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.event_sale_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_sale_alerts TO authenticated;
GRANT SELECT ON public.event_sale_alerts TO project_admin;

-- ---------------------------------------------------------------------------
-- Guard: client writes cannot open sales early, skip subscribers, or revive
-- a sold/cancelled event as Coming Soon.
-- ---------------------------------------------------------------------------
-- Has this event ever had tickets or an in-flight purchase? Bypasses the
-- caller's RLS (which hides other buyers' rows) but answers only for the
-- caller's own event (or an admin): for anyone else it is false, so it
-- reveals nothing. The guard below only asks it about an event the caller
-- is already allowed to update.
CREATE OR REPLACE FUNCTION public.event_has_sales_history(p_event_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.events e
                  WHERE e.id = p_event_id
                    AND (e.organizer_id = auth.uid() OR COALESCE(public.is_admin(), false)))
     AND (EXISTS (SELECT 1 FROM public.tickets t WHERE t.event_id = p_event_id)
          OR EXISTS (SELECT 1 FROM public.pending_purchases pp WHERE pp.event_id = p_event_id AND pp.status = 'pending'));
$function$;
REVOKE ALL ON FUNCTION public.event_has_sales_history(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_has_sales_history(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.events_sales_schedule_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- Privileged paths (SECURITY DEFINER functions, project_admin, maintenance
  -- SQL) are not refused, but a scheduled event still never goes on sale
  -- except through event_open_sales_core, which marks the one event it is
  -- opening (transaction-local). Anything else that sets it live -- e.g.
  -- admin_restore_deleted_event (0004), which always restores as 'live' --
  -- keeps it Coming Soon instead; the scheduler then opens it at its time
  -- and notifies its subscribers.
  IF current_user <> 'authenticated' THEN
    IF TG_OP = 'UPDATE' AND NEW.status = 'live' AND OLD.status IS DISTINCT FROM 'live'
       AND NEW.sales_open_at IS NOT NULL
       AND current_setting('vents.event_sales_opening', true) IS DISTINCT FROM NEW.id::text THEN
      NEW.status := 'coming_soon';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.sales_open_at IS NOT NULL AND NEW.sales_open_at <= now() THEN
      RAISE EXCEPTION 'The ticket sales opening time must be in the future';
    END IF;
    IF NEW.status = 'live' AND NEW.sales_open_at IS NOT NULL THEN
      RAISE EXCEPTION 'An event with a scheduled ticket sales opening is published as Coming Soon';
    END IF;
    IF NEW.status = 'coming_soon' AND NOT (COALESCE(public.is_organizer(), false) OR COALESCE(public.is_admin(), false)) THEN
      RAISE EXCEPTION 'Only approved organizers can publish events';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'coming_soon' THEN
      IF OLD.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'This event was cancelled; it cannot be published again';
      END IF;
      IF OLD.status = 'live' OR public.event_has_sales_history(OLD.id) THEN
        RAISE EXCEPTION 'Ticket sales have already started for this event; it cannot go back to Coming Soon';
      END IF;
      IF NOT (COALESCE(public.is_organizer(), false) OR COALESCE(public.is_admin(), false)) THEN
        RAISE EXCEPTION 'Only approved organizers can publish events';
      END IF;
      IF NOT (NEW.sales_open_at > now()) THEN
        RAISE EXCEPTION 'The ticket sales opening time must be in the future';
      END IF;
    ELSIF NEW.status = 'live' AND NEW.sales_open_at IS NOT NULL THEN
      RAISE EXCEPTION 'Ticket sales for this event open at the scheduled time (open_event_sales), not by publishing it directly';
    END IF;
  END IF;
  IF NEW.sales_open_at IS DISTINCT FROM OLD.sales_open_at THEN
    IF OLD.status = 'live' THEN
      RAISE EXCEPTION 'Ticket sales are already open; the opening time can no longer be changed';
    END IF;
    IF NEW.sales_open_at IS NULL THEN
      RAISE EXCEPTION 'A scheduled ticket sales opening cannot be removed; move it to another time instead';
    END IF;
    IF NEW.sales_open_at <= now() THEN
      RAISE EXCEPTION 'The ticket sales opening time must be in the future';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER events_sales_schedule_guard
  BEFORE INSERT OR UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_sales_schedule_guard();

-- ---------------------------------------------------------------------------
-- Opening sales (same event row) + exactly-once Notify-me fan-out
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.event_open_sales_core(p_event_id uuid, p_allow_draft boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  e        record;
  v_notified int;
BEGIN
  SELECT id, title, status, sales_open_at, deleted_at, hidden_by_admin, cancelled_at, event_date, end_date
    INTO e FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('opened', false, 'reason', 'not_found'); END IF;
  IF e.status = 'live' THEN RETURN jsonb_build_object('opened', false, 'reason', 'already_open'); END IF;
  IF NOT (e.status = 'coming_soon' OR (p_allow_draft AND e.status = 'draft' AND e.sales_open_at IS NOT NULL)) THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'not_scheduled');
  END IF;
  IF e.deleted_at IS NOT NULL OR e.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'unavailable');
  END IF;
  -- Admin-hidden: stays Coming Soon until an admin unhides it; the next run opens it.
  IF e.hidden_by_admin THEN RETURN jsonb_build_object('opened', false, 'reason', 'hidden_by_admin'); END IF;
  IF e.sales_open_at > now() THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'not_due', 'sales_open_at', e.sales_open_at);
  END IF;
  IF now() >= public.event_effective_end_at(e.event_date, e.end_date) THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'ended');
  END IF;

  -- The marker lets events_sales_schedule_guard tell this sanctioned
  -- opening apart from any other privileged write (transaction-local,
  -- cleared right after).
  PERFORM set_config('vents.event_sales_opening', e.id::text, true);
  UPDATE public.events SET status = 'live' WHERE id = e.id;
  PERFORM set_config('vents.event_sales_opening', '', true);

  -- Exactly once per subscriber: the marking and the notification are one
  -- statement in the transaction that opened sales. A retry finds nothing
  -- left to mark. Push delivery hangs off the notification row (0047); a
  -- failed push leaves that row's push_sent false for the push retry sweep
  -- and never creates a second notification.
  WITH due AS (
    UPDATE public.event_sale_alerts a
       SET notified_at = now()
     WHERE a.event_id = e.id AND a.notified_at IS NULL
    RETURNING a.user_id
  )
  INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
  SELECT d.user_id, 'event_update', 'Tickets are on sale',
         left(e.title, 150) || ' -- tickets are now on sale.', '🎟️',
         jsonb_build_object('type', 'event_sales_open', 'eventId', e.id::text)
    FROM due d
    JOIN public.users u ON u.id = d.user_id
   WHERE u.deleted_at IS NULL;
  GET DIAGNOSTICS v_notified = ROW_COUNT;

  RETURN jsonb_build_object('opened', true, 'notified', v_notified);
END;
$function$;
REVOKE ALL ON FUNCTION public.event_open_sales_core(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- Anyone may ask; it only ever opens a Coming Soon event whose time has come.
-- The event's organizer (or an admin) may also open a hidden-as-draft
-- scheduled event once its time has come.
CREATE OR REPLACE FUNCTION public.open_event_sales(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  e record;
  v_owner boolean;
BEGIN
  -- Cheap unlocked pre-check, so callers never lock a live event's row
  -- (purchases lock it too).
  SELECT status, sales_open_at, organizer_id INTO e FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('opened', false, 'reason', 'not_found'); END IF;
  IF e.status = 'live' THEN RETURN jsonb_build_object('opened', false, 'reason', 'already_open'); END IF;
  IF e.sales_open_at IS NULL THEN RETURN jsonb_build_object('opened', false, 'reason', 'not_scheduled'); END IF;
  IF e.sales_open_at > now() THEN
    RETURN jsonb_build_object('opened', false, 'reason', 'not_due', 'sales_open_at', e.sales_open_at);
  END IF;
  v_owner := auth.uid() IS NOT NULL AND (e.organizer_id = auth.uid() OR COALESCE(public.is_admin(), false));
  RETURN public.event_open_sales_core(p_event_id, v_owner);
END;
$function$;
REVOKE ALL ON FUNCTION public.open_event_sales(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_event_sales(uuid) TO anon, authenticated, project_admin;

-- Scheduler entry point. Each event opens in its own subtransaction, so one
-- failure never blocks the others; it is retried on the next run.
CREATE OR REPLACE FUNCTION public.open_due_event_sales(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r        record;
  v_res    jsonb;
  v_opened int := 0;
  v_notified int := 0;
  v_failed int := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.events
     WHERE status = 'coming_soon' AND sales_open_at <= now()
       AND deleted_at IS NULL AND hidden_by_admin IS NOT TRUE
     ORDER BY sales_open_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
  LOOP
    BEGIN
      v_res := public.event_open_sales_core(r.id, false);
      IF (v_res->>'opened')::boolean THEN
        v_opened := v_opened + 1;
        v_notified := v_notified + COALESCE((v_res->>'notified')::int, 0);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'open_due_event_sales: event % failed: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN jsonb_build_object('opened', v_opened, 'notified', v_notified, 'failed', v_failed);
END;
$function$;
REVOKE ALL ON FUNCTION public.open_due_event_sales(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_due_event_sales(integer) TO project_admin;

-- ---------------------------------------------------------------------------
-- Notify me: subscribe / unsubscribe / organizer counts (no subscriber PII)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscribe_event_sale_alert(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  e     record;
  v_n   int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in to get notified when tickets go on sale'; END IF;
  PERFORM public.check_rate_limit('event_sale_alert:' || v_uid::text, 30, 60);
  -- FOR SHARE serializes with event_open_sales_core's FOR UPDATE: a
  -- subscription racing the opening either commits first (and is notified
  -- by it) or waits and then sees the event on sale -- never a row the
  -- fan-out missed.
  SELECT status, deleted_at, hidden_by_admin, cancelled_at INTO e FROM public.events WHERE id = p_event_id FOR SHARE;
  IF NOT FOUND OR e.deleted_at IS NOT NULL OR e.hidden_by_admin OR e.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF e.status = 'live' THEN RAISE EXCEPTION 'Tickets are already on sale for this event'; END IF;
  IF e.status <> 'coming_soon' THEN RAISE EXCEPTION 'Event not found'; END IF;

  INSERT INTO public.event_sale_alerts (event_id, user_id) VALUES (p_event_id, v_uid)
  ON CONFLICT (event_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('subscribed', true, 'created', v_n = 1);
END;
$function$;
REVOKE ALL ON FUNCTION public.subscribe_event_sale_alert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscribe_event_sale_alert(uuid) TO authenticated, project_admin;

CREATE OR REPLACE FUNCTION public.unsubscribe_event_sale_alert(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  DELETE FROM public.event_sale_alerts
   WHERE event_id = p_event_id AND user_id = v_uid AND notified_at IS NULL;
  RETURN jsonb_build_object('subscribed', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.unsubscribe_event_sale_alert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_event_sale_alert(uuid) TO authenticated, project_admin;

-- Counts for the calling organizer's own scheduled events. Never who.
CREATE OR REPLACE FUNCTION public.get_my_event_sale_alert_counts()
 RETURNS TABLE(event_id uuid, subscribers integer, notified integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT e.id, count(a.user_id)::int, count(a.notified_at)::int
    FROM public.events e
    LEFT JOIN public.event_sale_alerts a ON a.event_id = e.id
   WHERE e.organizer_id = auth.uid() AND e.sales_open_at IS NOT NULL
   GROUP BY e.id;
$function$;
REVOKE ALL ON FUNCTION public.get_my_event_sale_alert_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_event_sale_alert_counts() TO authenticated, project_admin;

-- ---------------------------------------------------------------------------
-- Scheduler: pg_cron, every minute, inside the database.
--
-- Production does not have pg_cron enabled today (LAUNCH_CHECKLIST.md,
-- "Extensions": no pg_cron; 0198 header: no cron schema), and Vercel is on
-- the Hobby plan (daily crons only). Without this, a Coming Soon event could
-- open up to ~24 hours late. So this migration ENABLES pg_cron -- the
-- documented Supabase method (supabase.com/docs/guides/cron/install) -- and
-- REFUSES TO APPLY if it cannot register the job: a Coming Soon feature
-- that opens a day late is not shipped silently.
--
-- Result: sales open within about a minute of sales_open_at. Backstops: the
-- Vercel daily cron (api/cron/run.ts) and the app's lazy open_event_sales
-- call when someone views a due event. A late job only ever opens LATE,
-- never early. pg_cron never runs two instances of the same job at once,
-- and event_open_sales_core's row lock makes overlap harmless anyway.
--
-- Approving 0224 therefore also approves enabling the pg_cron extension.
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
      RAISE EXCEPTION '0224 refused: pg_cron is not available on this database, so Coming Soon events could not open on time';
    END IF;
    CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA cron TO postgres';
  EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres';

  -- cron.schedule(name, ...) creates or updates the named job (idempotent).
  EXECUTE $q$SELECT cron.schedule('vents_open_due_event_sales', '* * * * *', 'SELECT public.open_due_event_sales(200)')$q$;
  -- Keep the job's own run log small (one row a minute): 7 days, this job only.
  EXECUTE $q$SELECT cron.schedule('vents_open_due_event_sales_log_cleanup', '17 3 * * *',
    $j$DELETE FROM cron.job_run_details WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'vents_open_due_event_sales') AND end_time < now() - interval '7 days'$j$)$q$;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vents_open_due_event_sales'
                  AND schedule = '* * * * *' AND command = 'SELECT public.open_due_event_sales(200)' AND active) THEN
    RAISE EXCEPTION '0224 refused: the per-minute Coming Soon job was not registered';
  END IF;
END
$cron$;
