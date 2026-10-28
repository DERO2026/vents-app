-- 0199: private, authorized Realtime for private Chats and per-user activity.
--
-- Leak (verified live 2026-10-28 with pg_get_functiondef; identical to
-- 0004_functions.sql): notify_new_direct_message() broadcast every new DM,
-- INCLUDING ITS BODY, with
--   realtime.send(payload, 'new_message', 'user:' || recipient_id, false)
-- and notify_new_notification() and notify_vc_update() (VC transaction
-- user_id/amount/type) broadcast to the same 'user:<id>' topic, also with
-- private = false. A public channel has no authorization, so any
-- client holding the (public) anon key and a user's UUID could subscribe to
-- 'user:<uuid>' and read that user's incoming messages live, and see their
-- notification activity. Clients also SEND on public channels: typing
-- indicators were sent to the other user's 'user:<id>' topic, so anyone
-- could join anyone's personal topic, and spoof broadcasts into it.
-- realtime.messages has RLS enabled but no policies (live), so private
-- channels were unusable until now.
--
-- Fix:
--   1. All three triggers send with private = true. Private broadcasts are only
--      delivered to private-channel subscribers whose join passed the
--      realtime.messages policies below.
--   2. new_message no longer carries the body. Every client already treats
--      it as an invalidation signal (ConversationScreen reloads the thread
--      through direct_messages' own dm_select RLS); the payload keeps only
--      id / sender_id / recipient_id / created_at.
--   3. 'user:<uid>' topics: SELECT (receive) only for that uid. No INSERT
--      policy at all, so no client can broadcast into anyone's personal
--      topic -- only these SECURITY DEFINER triggers (which bypass RLS)
--      publish there.
--   4. Typing indicators move to a per-conversation topic
--      'dm:<uuid>:<uuid>' (clients put the two ids in sorted order). Only the
--      two participants may receive (SELECT) or send (INSERT) on it, and
--      neither may if either has blocked the other -- the same rule
--      send_direct_message() enforces for messages.
--
-- notify_vc_update() has no client consumer today; it keeps its payload
-- and only becomes private, so it can no longer be read by anyone else.
--
-- Only these two topic families get policies. Other Realtime topics
-- (admin:stats, door:<event>, organizer-events:<id>) stay public channels
-- and are unaffected: public channels never consult realtime.messages RLS.
-- anon gets no policy, so anonymous clients cannot join any private channel.

CREATE OR REPLACE FUNCTION public.notify_new_direct_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',           NEW.id,
      'sender_id',    NEW.sender_id,
      'recipient_id', NEW.recipient_id,
      'created_at',   NEW.created_at
    ),
    'new_message',
    'user:' || NEW.recipient_id::text,
    true
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_new_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',         NEW.id,
      'user_id',    NEW.user_id,
      'type',       NEW.type,
      'created_at', NEW.created_at
    ),
    'new_notification',
    'user:' || NEW.user_id::text,
    true
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_vc_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('user_id', NEW.user_id, 'amount', NEW.amount, 'type', NEW.type),
    'vc_updated',
    'user:' || NEW.user_id::text,
    true
  );
  RETURN NEW;
END;
$function$;

-- True when the caller is one of the two participants named in a
-- 'dm:<uuid>:<uuid>' topic, the two ids differ, and neither participant has
-- blocked the other. SECURITY DEFINER because blocked_users' own RLS only
-- shows a user the rows where they are the blocker, and "the other person
-- blocked me" must also deny. Returns only a boolean about the caller's own
-- conversation.
CREATE OR REPLACE FUNCTION public.can_access_dm_realtime_topic(p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_parts text[];
  v_a uuid;
  v_b uuid;
  v_other uuid;
BEGIN
  IF v_uid IS NULL OR p_topic IS NULL THEN
    RETURN false;
  END IF;

  v_parts := regexp_match(
    p_topic,
    '^dm:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  );
  IF v_parts IS NULL THEN
    RETURN false;
  END IF;

  v_a := v_parts[1]::uuid;
  v_b := v_parts[2]::uuid;
  IF v_a = v_b THEN
    RETURN false;
  END IF;

  IF v_uid = v_a THEN
    v_other := v_b;
  ELSIF v_uid = v_b THEN
    v_other := v_a;
  ELSE
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1 FROM public.blocked_users
     WHERE (blocker_id = v_uid AND blocked_id = v_other)
        OR (blocker_id = v_other AND blocked_id = v_uid)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.can_access_dm_realtime_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_dm_realtime_topic(text) TO authenticated;

-- Receive: your own personal topic, or a DM topic you are a participant in.
DROP POLICY IF EXISTS vents_private_topics_receive ON realtime.messages;
CREATE POLICY vents_private_topics_receive ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND (
      (SELECT realtime.topic()) = 'user:' || (SELECT auth.uid())::text
      OR public.can_access_dm_realtime_topic((SELECT realtime.topic()))
    )
  );

-- Send: DM topics you are a participant in (typing indicators) only.
-- Deliberately no rule for 'user:' topics.
DROP POLICY IF EXISTS vents_private_topics_send ON realtime.messages;
CREATE POLICY vents_private_topics_send ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'broadcast'
    AND public.can_access_dm_realtime_topic((SELECT realtime.topic()))
  );
