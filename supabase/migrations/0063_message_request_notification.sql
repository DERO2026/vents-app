-- Adds the one notification-creation event that was genuinely missing:
-- when a brand-new message request is created and lands as 'pending' (the
-- recipient has never exchanged messages with this sender before), notify
-- the recipient with the real conversation_requests row id (for dedup/
-- identification) and the sender's real user id, routed to the existing
-- Message Requests overlay in ExploreScreen.tsx -- never a normal
-- conversation, since the request hasn't been accepted yet.
--
-- Structurally duplicate-proof: this INSERT sits inside the `IF v_req IS
-- NULL THEN` branch, which only runs once -- the moment conversation_
-- requests first gets a row for this pair. Every later call for the same
-- pair (more messages while still pending, or after accept/decline) finds
-- v_req already set and skips this branch entirely, so the recipient can
-- never get two "wants to message you" notifications for the same request.
--
-- No schema changes -- push_data already exists (0010).

CREATE OR REPLACE FUNCTION public.send_direct_message(p_recipient_id uuid, p_body text DEFAULT ''::text, p_event_id uuid DEFAULT NULL::uuid, p_image_url text DEFAULT NULL::text, p_media_type text DEFAULT NULL::text, p_reply_to_id uuid DEFAULT NULL::uuid)
 RETURNS direct_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sender uuid := auth.uid();
  v_req public.conversation_requests;
  v_msg public.direct_messages;
  v_has_history boolean;
  v_sender_name text;
  v_preview text;
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

  SELECT * INTO v_req FROM public.conversation_requests
  WHERE (requester_id = v_sender AND recipient_id = p_recipient_id)
     OR (requester_id = p_recipient_id AND recipient_id = v_sender)
  LIMIT 1;

  IF v_req IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.direct_messages
      WHERE (sender_id = v_sender AND recipient_id = p_recipient_id)
         OR (sender_id = p_recipient_id AND recipient_id = v_sender)
    ) INTO v_has_history;

    INSERT INTO public.conversation_requests (requester_id, recipient_id, status, responded_at)
    VALUES (v_sender, p_recipient_id, CASE WHEN v_has_history THEN 'accepted' ELSE 'pending' END, CASE WHEN v_has_history THEN now() ELSE NULL END)
    RETURNING * INTO v_req;

    -- Only when this is a genuinely new, still-pending request (not the
    -- v_has_history auto-accept case above, which needs no request
    -- notification since it behaves like an ordinary message from here).
    IF v_req.status = 'pending' THEN
      SELECT coalesce(full_name, username, 'Someone') INTO v_sender_name
        FROM public.users WHERE id = v_sender;
      INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
      VALUES (
        p_recipient_id,
        'social',
        v_sender_name || ' wants to message you',
        'Tap to view the request.',
        '✉️',
        jsonb_build_object('requestId', v_req.id, 'userId', v_sender, 'screen', 'message-requests')
      );
    END IF;
  ELSIF v_req.status = 'declined' THEN
    RAISE EXCEPTION 'This user is not accepting messages from you right now';
  ELSIF v_req.status = 'pending' AND v_req.requester_id = p_recipient_id THEN
    UPDATE public.conversation_requests
    SET status = 'accepted', responded_at = now()
    WHERE id = v_req.id;

    -- Each party's counterpart is the OTHER side of this exact request row
    -- (not v_sender/p_recipient_id directly -- that mapping flips depending
    -- on who originally sent the first message), so push_data.userId always
    -- names the real person the recipient can now message, never guessed.
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES
      (v_req.requester_id, 'social', 'Message request accepted', 'You can now message each other.', '💬',
       jsonb_build_object('userId', v_req.recipient_id, 'screen', 'chat')),
      (v_req.recipient_id, 'social', 'Messaging enabled', 'You can now message each other.', '💬',
       jsonb_build_object('userId', v_req.requester_id, 'screen', 'chat'));
  END IF;

  INSERT INTO public.direct_messages (sender_id, recipient_id, event_id, body, image_url, media_type, reply_to_id)
  VALUES (v_sender, p_recipient_id, p_event_id, coalesce(p_body, ''), p_image_url, p_media_type, p_reply_to_id)
  RETURNING * INTO v_msg;

  -- Push-eligible notification for the recipient. Only when the request is
  -- already 'accepted' (a still-'pending' first message instead fires the
  -- "wants to message you" request notification above).
  IF v_req.status = 'accepted' THEN
    SELECT coalesce(full_name, username, 'Someone') INTO v_sender_name
      FROM public.users WHERE id = v_sender;
    v_preview := CASE
      WHEN p_image_url IS NOT NULL AND coalesce(trim(p_body), '') = '' THEN '📷 Photo'
      WHEN length(coalesce(p_body, '')) > 80 THEN left(p_body, 77) || '...'
      ELSE coalesce(p_body, '')
    END;
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      p_recipient_id,
      'message',
      v_sender_name,
      v_preview,
      '💬',
      jsonb_build_object('userId', v_sender, 'screen', 'chat')
    );
  END IF;

  RETURN v_msg;
END;
$function$
;
