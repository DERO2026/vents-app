-- Event-driven push delivery -- replaces reliance on a frequent Vercel Cron
-- (not viable on the Hobby plan, which caps cron invocation frequency to
-- once/day regardless of the schedule string configured) with a
-- request-triggered delivery path that fires immediately after a
-- notification is created, from the same server-side code that already
-- creates it (the Paystack webhook) or from the client that just performed
-- the action (ticket-transfer initiate/decline, service-provider admin
-- decision) via a lightweight relay endpoint.
--
-- Both new functions are project_admin-only (no authenticated/anon grant),
-- exactly like the existing get_pending_push_notifications and
-- mark_notifications_pushed (0004_functions.sql) -- device tokens must
-- never be readable via a client-callable RPC. The relay endpoint
-- (api/push/send.ts) accepts a target user id from any authenticated
-- caller, but only ever uses it to look up and deliver that user's own
-- already-existing, already-legitimate unsent notification rows via the
-- project_admin Postgres connection (api/_lib/projectAdminDb.ts) -- the
-- caller never sees a device token, and cannot compose or spoof content
-- (it isn't accepted as input at all in this path).
--
-- The daily cron sweep (api/cron/run.ts, vercel.json) remains, unchanged in
-- cadence, purely as a safety net for whatever this on-demand path misses
-- (an app closed before the client-side call fires, a webhook retry, etc.)
-- and for the 24h/1h event-reminder sweep, which has no natural "moment of
-- creation" to hook into.

-- Same shape as get_pending_push_notifications, scoped to one user.
CREATE FUNCTION public.get_pending_push_notifications_for_user(p_user_id uuid, p_limit integer DEFAULT 20)
 RETURNS TABLE(notification_id uuid, user_id uuid, title text, body text, push_data jsonb, token text, platform text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT n.id, n.user_id, n.title, n.body, n.push_data, d.token, d.platform
    FROM public.notifications n
    LEFT JOIN public.device_push_tokens d ON d.user_id = n.user_id
   WHERE n.push_sent = false
     AND n.user_id = p_user_id
   ORDER BY n.created_at
   LIMIT p_limit;
$function$
;

REVOKE ALL ON FUNCTION public.get_pending_push_notifications_for_user(uuid, integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notifications_for_user(uuid, integer) TO project_admin;

-- Lets the Paystack webhook (already project_admin-authenticated, see
-- api/webhook/paystack.ts) resolve who to notify right after
-- confirm_transfer_fee_payment succeeds -- that RPC only returns a status
-- string, and its own notification always targets from_user_id, not the
-- to_user_id get_transfer_fee_payment_owner (0043) already exposes.
CREATE FUNCTION public.get_ticket_transfer_from_user(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT from_user_id FROM public.ticket_transfers WHERE fee_payment_ref = p_reference;
$function$
;

REVOKE ALL ON FUNCTION public.get_ticket_transfer_from_user(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_ticket_transfer_from_user(text) TO project_admin;
