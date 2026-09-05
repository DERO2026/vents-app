-- Genuinely server-side push delivery trigger -- closes the gap the
-- previous stage left open: initiate/decline-transfer and the
-- service-provider admin decision only triggered delivery via a CLIENT-side
-- POST (triggerPushDelivery in src/lib/pushNotifications.ts), which does
-- nothing when the VENTS app is fully closed. The Paystack webhook path
-- (server-side already) was correct; this migration gives every
-- `notifications` INSERT the same guarantee, regardless of what created it
-- or whether any client is open, using Supabase's own pg_net extension --
-- the same mechanism Supabase's Database Webhooks feature uses under the
-- hood, chosen over standing up a new Edge Function (this project has none
-- today and Vercel already hosts the FCM-signing code + credential) or a
-- second polling loop (that's exactly the cron dependency being removed).
--
-- Preferred architecture, now actually server-side end to end:
--   INSERT INTO notifications
--     -> trg_notify_push_on_notification_insert (AFTER INSERT trigger)
--     -> pg_net.http_post (async, fire-and-forget, never blocks the INSERT)
--     -> POST /api/push/send (Vercel, shared-secret authenticated)
--     -> deliverPendingPushesForUser (api/_lib/pushDelivery.ts, unchanged)
--     -> FCM v1 -> APNs/native Android -> device, app open or fully closed
--
-- ── 1) Race fix: claim-before-send, so no two callers (this trigger, the
-- client's triggerPushDelivery, and the daily cron sweep) can ever send the
-- same row twice, while still allowing a safe retry if a claimed send never
-- actually completes (function cold-start crash, FCM outage, etc). A short
-- claim window is enough: push_sent=true is still the only PERMANENT mark,
-- set only after FCM actually accepts the message (or the token is dead) in
-- deliverPendingPushesForUser/api/cron/run.ts (both unchanged) --
-- push_claim_expires_at only prevents a second reader from picking up the
-- same still-in-flight row inside that window.
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS push_claim_expires_at timestamptz;

-- Same external contract (params, return columns) as the version created in
-- 0046 -- CREATE OR REPLACE, not DROP+CREATE, so nothing calling it needs
-- to change. Internals now atomically claim (UPDATE ... RETURNING under
-- FOR UPDATE SKIP LOCKED) instead of a plain SELECT.
CREATE OR REPLACE FUNCTION public.get_pending_push_notifications_for_user(p_user_id uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(notification_id uuid, user_id uuid, title text, body text, push_data jsonb, token text, platform text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.notifications n
       SET push_claim_expires_at = now() + interval '2 minutes'
      FROM (
        SELECT id FROM public.notifications
         WHERE user_id = p_user_id
           AND push_sent = false
           AND (push_claim_expires_at IS NULL OR push_claim_expires_at < now())
         ORDER BY created_at
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
      ) pick
     WHERE n.id = pick.id
    RETURNING n.id, n.user_id, n.title, n.body, n.push_data
  )
  SELECT c.id, c.user_id, c.title, c.body, c.push_data, d.token, d.platform
    FROM claimed c
    LEFT JOIN public.device_push_tokens d ON d.user_id = c.user_id;
END;
$function$
;

-- Same treatment for the bulk daily-sweep reader (0004_functions.sql) --
-- api/cron/run.ts calls this by name with no changes needed; it just stops
-- being able to race the trigger/client path for the same row.
CREATE OR REPLACE FUNCTION public.get_pending_push_notifications(p_limit integer DEFAULT 200)
 RETURNS TABLE(notification_id uuid, user_id uuid, title text, body text, push_data jsonb, token text, platform text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.notifications n
       SET push_claim_expires_at = now() + interval '2 minutes'
      FROM (
        SELECT id FROM public.notifications
         WHERE push_sent = false
           AND (push_claim_expires_at IS NULL OR push_claim_expires_at < now())
         ORDER BY created_at
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
      ) pick
     WHERE n.id = pick.id
    RETURNING n.id, n.user_id, n.title, n.body, n.push_data
  )
  SELECT c.id, c.user_id, c.title, c.body, c.push_data, d.token, d.platform
    FROM claimed c
    LEFT JOIN public.device_push_tokens d ON d.user_id = c.user_id;
END;
$function$
;

-- ── 2) The actual server-side trigger ───────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- One-row config table -- holds the Vercel relay URL + a shared secret the
-- trigger sends as a header, so api/push/send.ts can tell a genuine
-- database-originated call from a random POST without needing any Supabase
-- user session (there isn't one inside a trigger). No RLS policy is
-- granted to anon/authenticated at all, so PostgREST can never read or
-- write this table for those roles; only project_admin (and superuser
-- migrations, like this one) can touch it. The secret is never returned to
-- any client -- it only ever travels from this trigger to the Vercel
-- endpoint over a server-to-server HTTPS call.
CREATE TABLE IF NOT EXISTS public.push_delivery_webhook_config (
  id boolean PRIMARY KEY DEFAULT true,
  webhook_url text NOT NULL,
  webhook_secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_delivery_webhook_config_singleton CHECK (id = true)
);
ALTER TABLE public.push_delivery_webhook_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_delivery_webhook_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.push_delivery_webhook_config TO project_admin;

-- MANUAL ONE-TIME SETUP (not something this migration can safely do itself
-- -- the value is a deployment URL + a secret that must match Vercel's
-- PUSH_WEBHOOK_SECRET env var, neither of which belongs hardcoded in a
-- migration file that ships to every environment):
--   INSERT INTO public.push_delivery_webhook_config (id, webhook_url, webhook_secret)
--   VALUES (true, 'https://<your-production-domain>/api/push/send', '<same value as Vercel PUSH_WEBHOOK_SECRET>')
--   ON CONFLICT (id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, webhook_secret = EXCLUDED.webhook_secret, updated_at = now();
-- Run via the Supabase SQL editor with a role that can see this table
-- (project_admin or the Postgres superuser), never via the app.

CREATE OR REPLACE FUNCTION public.notify_push_on_notification_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT webhook_url, webhook_secret INTO v_url, v_secret
    FROM public.push_delivery_webhook_config WHERE id = true;

  -- Not configured yet (fresh environment before the one-time INSERT
  -- above) -- never block the notification insert itself; the daily cron
  -- sweep still covers delivery either way.
  IF v_url IS NULL THEN RETURN NEW; END IF;

  -- extensions.net.http_post queues the request on pg_net's background
  -- worker and returns immediately (a bigint request id, discarded here) --
  -- this trigger never waits on the HTTP call, so a slow/unreachable
  -- endpoint can never slow down or fail the INSERT that fired it.
  PERFORM extensions.net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-webhook-secret', v_secret),
    body := jsonb_build_object('userId', NEW.user_id, 'notificationId', NEW.id)
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- pg_net misconfigured/disabled, or any other unexpected error -- never
  -- let dispatching the webhook fail the notification insert. The row is
  -- still created (in-app history is unaffected) and the daily cron sweep
  -- remains the safety net.
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.notify_push_on_notification_insert() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.notify_push_on_notification_insert() TO anon, authenticated, project_admin;

DROP TRIGGER IF EXISTS trg_notify_push_on_notification_insert ON public.notifications;
CREATE TRIGGER trg_notify_push_on_notification_insert
  AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notify_push_on_notification_insert();
