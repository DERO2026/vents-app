-- Fix: the on-demand push webhook trigger introduced in
-- 0047_push_delivery_db_webhook.sql has never actually fired. It called
-- `extensions.net.http_post(...)`, but pg_net registers its functions under
-- the fixed schema `net` regardless of which schema the extension itself is
-- installed into (`CREATE EXTENSION pg_net WITH SCHEMA extensions` only
-- places the extension's catalog entry there; its functions are still
-- `net.http_post`, confirmed live via pg_proc). `extensions.net.http_post`
-- parses as a 3-part cross-database reference ("cross-database references
-- are not implemented", SQLSTATE 0A000) and was silently swallowed by the
-- trigger's own `EXCEPTION WHEN OTHERS THEN RETURN NEW` on every single
-- call, for every notification type, since this trigger was created.
--
-- Net effect confirmed live: zero rows ever appeared in `net._http_response`
-- or `net.http_request_queue` for this trigger, despite the trigger being
-- enabled and `push_delivery_webhook_config` being correctly populated. The
-- only working delivery path in production has been the once-a-day Vercel
-- cron sweep (api/cron/run.ts) plus the two narrow client-side
-- `triggerPushDelivery()` call sites (ticket transfer, admin provider
-- decisions) -- chat messages have neither, so a chat push could be delayed
-- up to ~24h. This migration only fixes the schema-qualified function call;
-- nothing else about the trigger's behavior, auth, or payload changes.
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

  IF v_url IS NULL THEN RETURN NEW; END IF;

  -- net.http_post (not extensions.net.http_post -- pg_net's functions live
  -- in the fixed `net` schema no matter which schema the extension itself
  -- was installed into). Queues the request on pg_net's background worker
  -- and returns immediately; this trigger never waits on the HTTP call.
  PERFORM net.http_post(
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

-- Second, independent defect found live while verifying the fix above:
-- get_pending_push_notifications_for_user (called by both this trigger via
-- /api/push/send and the client-side triggerPushDelivery accelerator) threw
-- `42702: column reference "user_id" is ambiguous` on every single
-- invocation -- the inner subquery's unqualified `user_id` collided with the
-- outer `UPDATE public.notifications n` target it runs inside. Confirmed
-- live via `SELECT * FROM get_pending_push_notifications_for_user(...)`.
-- deliverPendingPushesForUser's catch-all (api/_lib/pushDelivery.ts) swallows
-- this and returns {sent:0,total:0} -- so even with the trigger's http_post
-- call now reaching /api/push/send, real-time delivery still silently did
-- nothing. The only thing that has ever actually delivered a push in
-- production is the daily cron's sibling function
-- get_pending_push_notifications (no per-user filter, so no ambiguity).
-- Fix: qualify the inner subquery's own notifications scan with its own
-- alias so `user_id` can no longer resolve to the outer UPDATE target.
-- Same signature, same external contract -- CREATE OR REPLACE only.
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
        SELECT pn.id FROM public.notifications pn
         WHERE pn.user_id = p_user_id
           AND pn.push_sent = false
           AND (pn.push_claim_expires_at IS NULL OR pn.push_claim_expires_at < now())
         ORDER BY pn.created_at
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
