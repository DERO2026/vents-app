-- send_direct_message treated every pair with no conversation_requests row
-- as a brand-new request, including pairs that already had message
-- history from before this feature shipped — a legacy conversation with
-- years of back-and-forth would suddenly show "message request sent,
-- you'll be notified when X accepts" on the very next message. Backfill:
-- if prior direct_messages already exist between the two users, the
-- request row is created as already 'accepted', not 'pending'.
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
  v_has_history boolean;
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
  ELSIF v_req.status = 'declined' THEN
    RAISE EXCEPTION 'This user is not accepting messages from you right now';
  ELSIF v_req.status = 'pending' AND v_req.requester_id = p_recipient_id THEN
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

-- One-time backfill for pairs that already have message history from
-- before this migration but no request row yet (created between the
-- previous migration landing and this fix) — same rule as above.
INSERT INTO public.conversation_requests (requester_id, recipient_id, status, responded_at, created_at)
SELECT DISTINCT ON (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id))
  sender_id, recipient_id, 'accepted', now(), now()
FROM public.direct_messages dm
WHERE NOT EXISTS (
  SELECT 1 FROM public.conversation_requests cr
  WHERE (cr.requester_id = dm.sender_id AND cr.recipient_id = dm.recipient_id)
     OR (cr.requester_id = dm.recipient_id AND cr.recipient_id = dm.sender_id)
)
ORDER BY LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), dm.created_at ASC;
