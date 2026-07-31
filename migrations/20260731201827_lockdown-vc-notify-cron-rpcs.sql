-- Final authorization sweep (2026-07-31): _vc_deduct, notify_user,
-- send_event_reminders, and lift_expired_bans were SECURITY DEFINER with
-- EXECUTE held by PUBLIC/authenticated and NO internal auth check — the
-- same defect class already fixed on the payout/ticket-payment RPCs.
--
-- _vc_deduct(uuid, integer, text) is the most severe: it takes p_user_id
-- straight from the caller and does
--   UPDATE vents_wallets SET balance = balance - p_amount WHERE user_id = p_user_id
-- with no auth.uid() check at all. Any unauthenticated client could POST
-- /api/database/rpc/_vc_deduct with an arbitrary user id and drain that
-- user's Vents Cents balance repeatedly. It is only ever called from other
-- SECURITY DEFINER functions (boost_event_vc, purchase_badge,
-- feature_in_people_vc) which run as owner, so revoking anon/authenticated
-- breaks nothing legitimate.
--
-- notify_user(uuid, text, text, text, text) is a bare INSERT INTO
-- notifications for an arbitrary target user id and fully attacker-
-- controlled title/body — a phishing/spam vector open to anon. Only ever
-- called from triggers and other definer functions.
--
-- send_event_reminders() bulk-inserts notifications with no auth check.
-- Its own 24h dedupe bounds repeat-spam, but it has no business being
-- anon-callable; it is meant to run from a scheduled job only.
--
-- lift_expired_bans() was granted to `authenticated` with no auth check —
-- any signed-in user could trigger it. Impact was bounded (only touches
-- rows whose banned_until has already passed), but like every other
-- moderation RPC it should be system/scheduler-only.
--
-- All four are only ever invoked server-side (other definer functions,
-- scheduled jobs), so locking them to project_admin has no legitimate
-- functional impact.
REVOKE EXECUTE ON FUNCTION public._vc_deduct(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_event_reminders() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lift_expired_bans() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._vc_deduct(uuid, integer, text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.send_event_reminders() TO project_admin;
GRANT EXECUTE ON FUNCTION public.lift_expired_bans() TO project_admin;

-- attach_ticket_refund_id had a redundant hardcoded-UUID allowlist clause
-- alongside the normal organizer-or-is_admin() check. That account already
-- satisfies is_admin() through the normal path, so the extra clause added
-- a permanent, unauditable identity-based bypass for no functional gain.
-- Removed; authorization is now organizer-or-admin only.
CREATE OR REPLACE FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_status       text;
  v_user_id      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT e.organizer_id, t.payment_status, t.user_id INTO v_organizer_id, v_status, v_user_id
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Ticket is not awaiting a refund (status: %)', v_status;
  END IF;

  UPDATE public.tickets SET refund_id = p_refund_id WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'attach_ticket_refund_id', v_user_id,
          jsonb_build_object('ticket_id', p_ticket_id, 'refund_id', p_refund_id), public.actor_role());
END;
$function$;
