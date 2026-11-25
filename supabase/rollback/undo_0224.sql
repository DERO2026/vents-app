-- Undo 0224 only (supabase/migrations/0224_coming_soon_events.sql).
-- NOT a migration; never applied by tooling. In one transaction:
--   SET vents.rollback_confirm = 'undo-0224';
--   \i supabase/rollback/undo_0224.sql
-- Removes the Coming Soon status, events.sales_open_at, the Notify-me
-- subscriptions, the guard trigger, the 0224 functions and the pg_cron job.
--
-- Survives the undo: every event row and id; events whose sales already
-- opened stay 'live' (ordinary on-sale events); notifications already
-- delivered; all tickets, purchases and money (0224 never touches them).
-- Lost:
--   * Events still 'coming_soon' would violate 0005's status CHECK, so the
--     undo refuses while any exist unless
--       SET vents.rollback_coming_soon_to_draft = 'yes';
--     which turns them into private drafts (nothing was sold on them; the
--     organizer can make them live again with the existing controls).
--   * Pending "Notify me" subscriptions (never notified). The undo refuses
--     while any exist unless
--       SET vents.rollback_discard_sale_alerts = 'yes';
--   * The planned sales opening time of every event (sales_open_at).
-- Kept on purpose: the pg_cron extension 0224 enabled. Only 0224's two jobs
-- are removed; dropping the extension would delete every other cron job
-- too (Supabase docs), so that stays a separate, explicit decision.
DO $undo$
DECLARE
  v_pending bigint;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0224' THEN
    RAISE EXCEPTION 'undo_0224 refused: set vents.rollback_confirm = ''undo-0224'' to confirm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.events WHERE status = 'coming_soon')
     AND current_setting('vents.rollback_coming_soon_to_draft', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'undo_0224 refused: % Coming Soon event(s) exist. Set vents.rollback_coming_soon_to_draft = ''yes'' to turn them into drafts',
      (SELECT count(*) FROM public.events WHERE status = 'coming_soon');
  END IF;
  IF to_regclass('public.event_sale_alerts') IS NOT NULL THEN
    -- Dynamic so a re-run (table already dropped) still plans.
    EXECUTE 'SELECT count(*) FROM public.event_sale_alerts WHERE notified_at IS NULL' INTO v_pending;
    IF v_pending > 0 AND current_setting('vents.rollback_discard_sale_alerts', true) IS DISTINCT FROM 'yes' THEN
      RAISE EXCEPTION 'undo_0224 refused: % pending Notify-me subscription(s) would be discarded. Set vents.rollback_discard_sale_alerts = ''yes'' to proceed', v_pending;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('vents_open_due_event_sales', 'vents_open_due_event_sales_log_cleanup')$q$;
  END IF;
END
$undo$;

DROP TRIGGER IF EXISTS events_sales_schedule_guard ON public.events;

UPDATE public.events SET status = 'draft' WHERE status = 'coming_soon';

DROP FUNCTION IF EXISTS public.get_my_event_sale_alert_counts();
DROP FUNCTION IF EXISTS public.unsubscribe_event_sale_alert(uuid);
DROP FUNCTION IF EXISTS public.subscribe_event_sale_alert(uuid);
DROP FUNCTION IF EXISTS public.open_due_event_sales(integer);
DROP FUNCTION IF EXISTS public.open_event_sales(uuid);
DROP FUNCTION IF EXISTS public.event_open_sales_core(uuid, boolean);
DROP FUNCTION IF EXISTS public.events_sales_schedule_guard();
DROP FUNCTION IF EXISTS public.event_has_sales_history(uuid);
DROP TABLE IF EXISTS public.event_sale_alerts;

DROP INDEX IF EXISTS public.idx_events_coming_soon_due;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_sales_open_before_start;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_coming_soon_sales_time;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text])));
ALTER TABLE public.events DROP COLUMN IF EXISTS sales_open_at;
