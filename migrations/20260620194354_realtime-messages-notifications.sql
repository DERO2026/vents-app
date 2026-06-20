-- Realtime channel patterns for per-user push events
INSERT INTO realtime.channels (pattern, description, enabled)
VALUES ('user:%', 'Per-user messages and notifications', true)
ON CONFLICT (pattern) DO UPDATE
  SET description = EXCLUDED.description,
      enabled     = EXCLUDED.enabled;

-- Trigger: publish to recipient's channel when a new DM is inserted
CREATE OR REPLACE FUNCTION public.notify_new_direct_message()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'user:' || NEW.recipient_id::text,
    'new_message',
    jsonb_build_object(
      'id',           NEW.id,
      'sender_id',    NEW.sender_id,
      'recipient_id', NEW.recipient_id,
      'body',         NEW.body,
      'created_at',   NEW.created_at
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_realtime_new_dm ON public.direct_messages;
CREATE TRIGGER trg_realtime_new_dm
AFTER INSERT ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.notify_new_direct_message();

-- Trigger: publish to user's channel when a new notification is inserted
CREATE OR REPLACE FUNCTION public.notify_new_notification()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'user:' || NEW.user_id::text,
    'new_notification',
    jsonb_build_object(
      'id',         NEW.id,
      'user_id',    NEW.user_id,
      'type',       NEW.type,
      'created_at', NEW.created_at
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_realtime_new_notification ON public.notifications;
CREATE TRIGGER trg_realtime_new_notification
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.notify_new_notification();

-- Trigger: publish VC balance change when a transaction is inserted/updated
CREATE OR REPLACE FUNCTION public.notify_vc_update()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'user:' || NEW.user_id::text,
    'vc_updated',
    jsonb_build_object('user_id', NEW.user_id, 'amount', NEW.amount, 'type', NEW.type)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_realtime_vc ON public.vc_transactions;
CREATE TRIGGER trg_realtime_vc
AFTER INSERT OR UPDATE ON public.vc_transactions
FOR EACH ROW
EXECUTE FUNCTION public.notify_vc_update();