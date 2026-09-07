-- Adds push_data to two more notification-producing sites that were
-- creating notifications with an incomplete or missing routing payload:
-- the "Ticket confirmed" notification (previously eventId only, so a tap
-- could only ever land on Event Details, not the actual ticket) now also
-- carries ticketId; the "Message request accepted"/"Messaging enabled"
-- pair (previously no push_data at all) now carries the counterpart's
-- userId + screen:'chat', reusing the chat route that already exists.
-- No schema changes -- push_data already exists (0010). Every other
-- notification body/behavior/push trigger in these functions is
-- unchanged.

CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
  v_holder_name     text;
  v_holder_email    text;
  v_holder_phone    text;
  v_metadata        jsonb;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;

    -- Snapshot buyer info off the purchasing ticket (index 0 / the
    -- purchaser, per PurchasedTicket.attendees convention) -- holder_name/
    -- email/phone are themselves already immutable per-ticket snapshots
    -- (never rewritten post-purchase), so this is safe to capture once here.
    SELECT holder_name, holder_email, holder_phone
      INTO v_holder_name, v_holder_email, v_holder_phone
      FROM public.tickets WHERE id = v_first_ticket_id;

    v_metadata := jsonb_build_object(
      'event_title', v_event_title,
      'ticket_type', v_ticket_type,
      'quantity', v_ticket_count,
      'gross_kobo', v_credit_kobo,
      -- VENTS' 5% service fee is a buyer-side surcharge added on top at
      -- checkout, never deducted from the organizer -- net paid to the
      -- organizer equals gross. buyer_fee_kobo is what the buyer paid
      -- above the base gross (v_expected_kobo, already net of any promo
      -- discount, minus v_credit_kobo) -- informational only, recorded
      -- here so the receipt UI states this accurately instead of
      -- re-deriving fee semantics later.
      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),
      'paystack_reference', p_reference,
      'buyer_name', v_holder_name,
      'buyer_email', v_holder_email,
      'buyer_phone', v_holder_phone
    );

    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id,
      v_metadata
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id, 'ticketId', v_first_ticket_id)
  );

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$
;

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

  -- NEW: push-eligible notification for the recipient. Only when the
  -- request is already 'accepted' (a still-'pending' first message sits in
  -- the recipient's Message Requests inbox, not their main chat list -- a
  -- push for that would deep-link somewhere the tap can't actually resolve
  -- to a normal conversation yet).
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
