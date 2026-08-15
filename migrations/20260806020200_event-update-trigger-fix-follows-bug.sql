-- New: notify existing ticket holders when an event's date, time, or venue
-- changes — the one class of edit that actually invalidates plans someone
-- already made around the original details. Cosmetic edits (description,
-- flyer, ticket types) intentionally do NOT fire this — those aren't
-- "your plans just changed" news and would just be noise.
CREATE OR REPLACE FUNCTION public.notify_event_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF NEW.event_date IS DISTINCT FROM OLD.event_date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time
     OR NEW.end_time IS DISTINCT FROM OLD.end_time
     OR NEW.location IS DISTINCT FROM OLD.location
  THEN
    FOR v_ticket IN
      SELECT DISTINCT user_id FROM public.tickets
       WHERE event_id = NEW.id AND status = 'active'
    LOOP
      INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
      VALUES (
        v_ticket.user_id,
        'event_update',
        'Event details changed',
        NEW.title || ' has updated date, time, or location — check the latest details.',
        '📅',
        jsonb_build_object('eventId', NEW.id)
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_events_notify_update ON public.events;
CREATE TRIGGER trg_events_notify_update
  AFTER UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_event_update();

-- Fixes a live bug: 20260710212427_remove-subscribe-follow-system.sql
-- dropped public.follows (the follow/subscribe feature was fully removed),
-- but a later migration (20260730190000_delete-account-push-tokens-and-
-- follows.sql) re-added "DELETE FROM public.follows" inside
-- delete_own_account() — a reference to a table that no longer exists.
-- Every account-deletion attempt since that migration would throw
-- `relation "public.follows" does not exist` and fail outright. Removing
-- that line; everything else in the function is unchanged from the
-- 20260730190000 version.
CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_user RECORD;
  v_wallet_note jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_user FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_user.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted'; END IF;

  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO public.deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO public.deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  UPDATE public.tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

  DELETE FROM public.blocked_users WHERE blocker_id = v_uid OR blocked_id = v_uid;

  DELETE FROM public.direct_messages WHERE sender_id = v_uid OR recipient_id = v_uid;
  DELETE FROM public.conversation_clears WHERE user_id = v_uid OR other_user_id = v_uid;

  DELETE FROM public.device_push_tokens WHERE user_id = v_uid;

  DELETE FROM public.highlights WHERE user_id = v_uid;

  DELETE FROM public.organizer_reviews WHERE reviewer_id = v_uid OR organizer_id = v_uid;

  DELETE FROM public.reports WHERE reporter_id = v_uid;

  DELETE FROM public.vc_transactions WHERE user_id = v_uid;

  DELETE FROM public.notifications WHERE user_id = v_uid;

  DELETE FROM public.saved_events WHERE user_id = v_uid;

  SELECT jsonb_build_object('balance_kobo', balance_kobo, 'pending_kobo', pending_kobo)
    INTO v_wallet_note
  FROM public.organizer_wallets WHERE organizer_id = v_uid;

  DELETE FROM public.referred_emails WHERE referred_by = v_uid OR email = v_user.email;

  UPDATE public.users SET
    status         = 'deleted',
    deleted_at     = now(),
    original_email = email,
    email          = 'deleted_' || v_uid || '@deleted.vents',
    username       = 'deleted_' || left(v_uid::text, 8),
    full_name      = NULL,
    avatar_url     = NULL,
    cover_url      = NULL,
    bio            = NULL,
    phone_number   = NULL
  WHERE id = v_uid;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now(), 'wallet_at_deletion', v_wallet_note));

  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END; $function$;
