-- Dedup ledger for the 24h/1h event-reminder cron. One row per
-- (ticket, kind) that's already been sent — the sweep function below uses
-- this as its "have I already reminded this person" check rather than a
-- tight cron-run time window, so it's correct regardless of how often the
-- cron actually fires (every 5 min or every 20, a missed run just catches
-- up on the next one instead of double-sending or silently skipping).
CREATE TABLE IF NOT EXISTS public.event_reminder_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('24h', '1h')),
  sent_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, kind)
);

ALTER TABLE public.event_reminder_log ENABLE ROW LEVEL SECURITY;
-- No policies — deny-all for anon/authenticated, same posture as
-- device_push_tokens. Only ever touched by run_event_reminder_sweep()
-- below, which is project_admin-only (called from the cron endpoint using
-- the INSFORGE_API_KEY service credential, not a user session).

-- Scans upcoming events for the 24h-out and 1h-out reminder windows and
-- inserts one push-eligible notification per (active, paid) ticket holder
-- who hasn't already gotten that reminder. Uses event_date (the
-- authoritative start-instant timestamptz) rather than start_time (a
-- separate display-only text column) for the actual countdown math.
-- Idempotent/safe to call on any cadence — event_reminder_log's unique
-- constraint is the real guard against double-sending, not call frequency.
CREATE OR REPLACE FUNCTION public.run_event_reminder_sweep()
 RETURNS TABLE(reminders_24h integer, reminders_1h integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count_24h integer := 0;
  v_count_1h  integer := 0;
  v_row       record;
BEGIN
  FOR v_row IN
    SELECT t.id AS ticket_id, t.user_id, e.id AS event_id, e.title, e.event_date
      FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
     WHERE t.status = 'active'
       AND t.payment_status = 'paid'
       AND e.event_date > now()
       AND e.event_date <= now() + interval '24 hours'
       AND e.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.event_reminder_log l
          WHERE l.ticket_id = t.id AND l.kind = '24h'
       )
  LOOP
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      v_row.user_id, 'reminder', 'Tomorrow: ' || v_row.title,
      v_row.title || ' is happening in about 24 hours. Get ready!', '⏰',
      jsonb_build_object('eventId', v_row.event_id)
    );
    INSERT INTO public.event_reminder_log (ticket_id, kind) VALUES (v_row.ticket_id, '24h');
    v_count_24h := v_count_24h + 1;
  END LOOP;

  FOR v_row IN
    SELECT t.id AS ticket_id, t.user_id, e.id AS event_id, e.title, e.event_date
      FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
     WHERE t.status = 'active'
       AND t.payment_status = 'paid'
       AND e.event_date > now()
       AND e.event_date <= now() + interval '1 hour'
       AND e.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.event_reminder_log l
          WHERE l.ticket_id = t.id AND l.kind = '1h'
       )
  LOOP
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      v_row.user_id, 'reminder', 'Starting soon: ' || v_row.title,
      v_row.title || ' starts in about an hour!', '⏰',
      jsonb_build_object('eventId', v_row.event_id)
    );
    INSERT INTO public.event_reminder_log (ticket_id, kind) VALUES (v_row.ticket_id, '1h');
    v_count_1h := v_count_1h + 1;
  END LOOP;

  RETURN QUERY SELECT v_count_24h, v_count_1h;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_event_reminder_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_event_reminder_sweep() TO project_admin;


-- The push-delivery worker (api/cron/send-pending-pushes.ts) needs to read
-- unsent notifications across ALL users (not just its own — there is no
-- "own" for a cron job) and the device tokens to send to, then mark rows
-- sent and prune dead tokens. Bundled as one RPC so the cron endpoint isn't
-- shipping raw SQL over the REST RPC surface, and so token pruning stays
-- server-side/atomic with the read.
-- LEFT JOIN, not INNER — a user with zero registered devices (never opened
-- the native app, or unregistered) must still show up once so the caller
-- can mark their notification pushed (there's genuinely nothing to send)
-- instead of that row being re-selected on every future sweep forever.
CREATE OR REPLACE FUNCTION public.get_pending_push_notifications(p_limit integer DEFAULT 200)
 RETURNS TABLE(
   notification_id uuid,
   user_id         uuid,
   title           text,
   body            text,
   push_data       jsonb,
   token           text,
   platform        text
 )
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT n.id, n.user_id, n.title, n.body, n.push_data, d.token, d.platform
    FROM public.notifications n
    LEFT JOIN public.device_push_tokens d ON d.user_id = n.user_id
   WHERE n.push_sent = false
   ORDER BY n.created_at
   LIMIT p_limit;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_pending_push_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notifications(integer) TO project_admin;

CREATE OR REPLACE FUNCTION public.mark_notifications_pushed(p_ids uuid[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  UPDATE public.notifications SET push_sent = true WHERE id = ANY(p_ids);
$function$;

REVOKE EXECUTE ON FUNCTION public.mark_notifications_pushed(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notifications_pushed(uuid[]) TO project_admin;

CREATE OR REPLACE FUNCTION public.prune_push_token(p_token text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  DELETE FROM public.device_push_tokens WHERE token = p_token;
$function$;

REVOKE EXECUTE ON FUNCTION public.prune_push_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_push_token(text) TO project_admin;
