-- Messaging rebuild, part 1 (schema + backend). Adds:
--   1. conversation_requests — a new DM thread starts 'pending' until the
--      recipient replies or explicitly accepts/declines, instead of any
--      user being able to drop straight into anyone's inbox.
--   2. message_reactions — per-user emoji reactions on a message.
--   3. direct_messages.reply_to_id — quote/reply support.
--   4. users.last_active_at — lightweight presence ("online" = seen very
--      recently), bumped by a heartbeat RPC rather than a real realtime
--      presence channel.
--   5. send_direct_message()/respond_to_message_request() RPCs, and a
--      lockdown of direct INSERT on direct_messages — every send must now
--      go through send_direct_message so the request-gate can't be
--      bypassed by inserting the row directly (the same class of fix
--      already applied to tickets/payments elsewhere in this schema).

CREATE TABLE IF NOT EXISTS public.conversation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CONSTRAINT conversation_requests_no_self CHECK (requester_id <> recipient_id),
  CONSTRAINT conversation_requests_unique_pair UNIQUE (requester_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS conversation_requests_recipient_pending_idx
  ON public.conversation_requests (recipient_id, status);

ALTER TABLE public.conversation_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversation_requests_select ON public.conversation_requests
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR recipient_id = auth.uid());

-- No direct INSERT/UPDATE grant — rows are only ever created/updated by the
-- SECURITY DEFINER RPCs below, which run as postgres and bypass RLS.
GRANT SELECT ON public.conversation_requests TO authenticated;


CREATE TABLE IF NOT EXISTS public.message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.direct_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_reactions_unique_per_user UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON public.message_reactions (message_id);

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

-- Visible to anyone who can see the underlying message (sender or recipient).
CREATE POLICY message_reactions_select ON public.message_reactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.direct_messages dm
      WHERE dm.id = message_reactions.message_id
        AND (dm.sender_id = auth.uid() OR dm.recipient_id = auth.uid())
    )
  );

CREATE POLICY message_reactions_insert ON public.message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.direct_messages dm
      WHERE dm.id = message_reactions.message_id
        AND (dm.sender_id = auth.uid() OR dm.recipient_id = auth.uid())
    )
  );

CREATE POLICY message_reactions_delete ON public.message_reactions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.message_reactions TO authenticated;


ALTER TABLE public.direct_messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.direct_messages(id) ON DELETE SET NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz;


-- Every send (text, image, reply — voice notes and location are out of
-- scope for the rebuild and untouched here) goes through this RPC so the
-- request-gate is enforced in one place, not duplicated across every call
-- site. Behaviour:
--   - No prior request between these two users: creates one as 'pending'
--     (this is the requester's opening message) and inserts the message.
--   - Existing 'pending' request, sender IS the requester: just appends —
--     you can send more while waiting, same as iMessage/IG requests.
--   - Existing 'pending' request, sender IS the recipient (they replied
--     without using the explicit Accept button): implicit accept — flips
--     to 'accepted', notifies both sides, inserts the message.
--   - Existing 'accepted' request: normal send.
--   - Existing 'declined' request: blocked — the recipient chose not to
--     hear from this person.
CREATE OR REPLACE FUNCTION public.send_direct_message(
  p_recipient_id uuid,
  p_body text DEFAULT '',
  p_event_id uuid DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_media_type text DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL
)
RETURNS public.direct_messages
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_sender uuid := auth.uid();
  v_req public.conversation_requests;
  v_msg public.direct_messages;
  v_lo uuid;
  v_hi uuid;
BEGIN
  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_recipient_id = v_sender THEN
    RAISE EXCEPTION 'Cannot message yourself';
  END IF;
  IF coalesce(trim(p_body), '') = '' AND p_image_url IS NULL THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.blocked_users
    WHERE (blocker_id = p_recipient_id AND blocked_id = v_sender)
       OR (blocker_id = v_sender AND blocked_id = p_recipient_id)
  ) THEN
    RAISE EXCEPTION 'blocked';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(least(v_sender, p_recipient_id)::text || greatest(v_sender, p_recipient_id)::text, 0));

  -- The unique constraint is (requester_id, recipient_id) in that exact
  -- order — look up both directions since either side may have opened it.
  SELECT * INTO v_req FROM public.conversation_requests
  WHERE (requester_id = v_sender AND recipient_id = p_recipient_id)
     OR (requester_id = p_recipient_id AND recipient_id = v_sender)
  LIMIT 1;

  IF v_req IS NULL THEN
    INSERT INTO public.conversation_requests (requester_id, recipient_id, status)
    VALUES (v_sender, p_recipient_id, 'pending')
    RETURNING * INTO v_req;
  ELSIF v_req.status = 'declined' THEN
    RAISE EXCEPTION 'This user is not accepting messages from you right now';
  ELSIF v_req.status = 'pending' AND v_req.requester_id = p_recipient_id THEN
    -- The original recipient is now replying — implicit accept.
    UPDATE public.conversation_requests
    SET status = 'accepted', responded_at = now()
    WHERE id = v_req.id;

    INSERT INTO public.notifications (user_id, type, title, body, icon)
    VALUES
      (v_req.requester_id, 'social', 'Message request accepted', 'You can now message each other.', '💬'),
      (v_req.recipient_id, 'social', 'Messaging enabled', 'You can now message each other.', '💬');
  END IF;

  INSERT INTO public.direct_messages (sender_id, recipient_id, event_id, body, image_url, media_type, reply_to_id)
  VALUES (v_sender, p_recipient_id, p_event_id, coalesce(p_body, ''), p_image_url, p_media_type, p_reply_to_id)
  RETURNING * INTO v_msg;

  RETURN v_msg;
END;
$function$;

-- direct_messages already has dm_select/dm_insert/dm_update/dm_delete
-- (migrations/20260624171544) — dm_insert is exactly the "any authenticated
-- user can write a row for themselves with no gating at all" policy that
-- makes the request system above pointless if left in place. Drop it and
-- revoke direct INSERT so every send has to go through send_direct_message
-- (SECURITY DEFINER, runs as postgres) — the same pattern already used to
-- lock down tickets/payments in this schema. SELECT/UPDATE/DELETE policies
-- are untouched.
DROP POLICY IF EXISTS dm_insert ON public.direct_messages;

REVOKE INSERT ON public.direct_messages FROM authenticated;
GRANT EXECUTE ON FUNCTION public.send_direct_message(uuid, text, uuid, text, text, uuid) TO authenticated;


CREATE OR REPLACE FUNCTION public.respond_to_message_request(p_requester_id uuid, p_action text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_recipient uuid := auth.uid();
  v_req public.conversation_requests;
BEGIN
  IF v_recipient IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_action NOT IN ('accept', 'decline') THEN
    RAISE EXCEPTION 'Invalid action';
  END IF;

  SELECT * INTO v_req FROM public.conversation_requests
  WHERE requester_id = p_requester_id AND recipient_id = v_recipient AND status = 'pending'
  FOR UPDATE;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'No pending request from this user';
  END IF;

  UPDATE public.conversation_requests
  SET status = CASE WHEN p_action = 'accept' THEN 'accepted' ELSE 'declined' END,
      responded_at = now()
  WHERE id = v_req.id;

  IF p_action = 'accept' THEN
    INSERT INTO public.notifications (user_id, type, title, body, icon)
    VALUES
      (v_req.requester_id, 'social', 'Message request accepted', 'You can now message each other.', '💬'),
      (v_req.recipient_id, 'social', 'Messaging enabled', 'You can now message each other.', '💬');
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.respond_to_message_request(uuid, text) TO authenticated;


-- Toggle (add if absent, remove if present) — one round-trip for the
-- common "tap an emoji" interaction instead of the client having to know
-- whether it's adding or removing first.
CREATE OR REPLACE FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_deleted int;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.direct_messages
    WHERE id = p_message_id AND (sender_id = v_user OR recipient_id = v_user)
  ) THEN
    RAISE EXCEPTION 'Message not found';
  END IF;

  DELETE FROM public.message_reactions
  WHERE message_id = p_message_id AND user_id = v_user AND emoji = p_emoji;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted > 0 THEN
    RETURN false; -- removed
  END IF;

  INSERT INTO public.message_reactions (message_id, user_id, emoji)
  VALUES (p_message_id, v_user, p_emoji);
  RETURN true; -- added
END;
$function$;

GRANT EXECUTE ON FUNCTION public.toggle_message_reaction(uuid, text) TO authenticated;


-- Bumped periodically by the client while the app is foregrounded —
-- "online" is then just last_active_at within the last ~60s, computed
-- client-side. No real presence channel; a straightforward, honest
-- approximation ("online status if available" per the request).
CREATE OR REPLACE FUNCTION public.heartbeat_presence()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $function$
  UPDATE public.users SET last_active_at = now() WHERE id = auth.uid();
$function$;

GRANT EXECUTE ON FUNCTION public.heartbeat_presence() TO authenticated;


-- One-shot search across the caller's own DMs (optionally scoped to one
-- thread) — ILIKE is sufficient at this table's scale and avoids adding a
-- tsvector column/index for what is a lightweight in-app search, not a
-- primary product surface.
CREATE OR REPLACE FUNCTION public.search_direct_messages(p_query text, p_other_user_id uuid DEFAULT NULL)
RETURNS SETOF public.direct_messages
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF coalesce(trim(p_query), '') = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM public.direct_messages dm
  WHERE (dm.sender_id = v_user OR dm.recipient_id = v_user)
    AND coalesce(dm.deleted_by_sender, false) = false
    AND dm.body ILIKE '%' || p_query || '%'
    AND (
      p_other_user_id IS NULL
      OR dm.sender_id = p_other_user_id OR dm.recipient_id = p_other_user_id
    )
  ORDER BY dm.created_at DESC
  LIMIT 100;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_direct_messages(text, uuid) TO authenticated;
