-- Live Admin Console stats via InsForge Realtime, replacing the
-- "visit the Stats tab to see current numbers" manual-refresh-only flow.
--
-- Follows the same channel/trigger pattern already established in
-- migrations/20260620194354_realtime-messages-notifications.sql (per-user
-- 'user:%' channels for DMs/notifications), but 'admin:stats' is a single
-- fixed channel rather than a wildcard, since dashboard stats are a
-- platform-wide admin view, not per-user.

-- Register the channel.
INSERT INTO realtime.channels (pattern, description, enabled)
VALUES ('admin:stats', 'Live Admin Console dashboard stats updates', true)
ON CONFLICT (pattern) DO UPDATE
  SET description = EXCLUDED.description,
      enabled     = EXCLUDED.enabled;

-- Restrict who can subscribe: realtime.channels has never had RLS enabled
-- in this project (any pattern, including 'user:%', is currently readable
-- by anyone), so enabling it bare would silently break the existing DM /
-- notification realtime for every non-admin user. Instead, gate ONLY the
-- new 'admin:stats' pattern behind is_admin(), and explicitly preserve the
-- prior fully-open behavior for every other existing/future pattern.
ALTER TABLE realtime.channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY realtime_channels_admin_stats_gate ON realtime.channels
FOR SELECT
TO anon, authenticated
USING (
  pattern <> 'admin:stats' OR public.is_admin()
);

-- Trigger: publish on every new organizer transaction (payout completions,
-- cancellation refunds, ticket-sale credits, etc.)
CREATE OR REPLACE FUNCTION public.notify_admin_stats_transaction()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'admin:stats',
    'admin_stats_changed',
    jsonb_build_object('source', 'transaction', 'id', NEW.id, 'type', NEW.type, 'created_at', NEW.created_at)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_realtime_admin_stats_transaction ON public.organizer_transactions;
CREATE TRIGGER trg_realtime_admin_stats_transaction
AFTER INSERT ON public.organizer_transactions
FOR EACH ROW
EXECUTE FUNCTION public.notify_admin_stats_transaction();

-- Trigger: publish on every payout request and every payout status change
-- (pending -> processing -> completed/failed, or rejected/cancelled)
CREATE OR REPLACE FUNCTION public.notify_admin_stats_payout()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'admin:stats',
    'admin_stats_changed',
    jsonb_build_object('source', 'payout', 'id', NEW.id, 'status', NEW.status, 'updated_at', NEW.updated_at)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_realtime_admin_stats_payout ON public.organizer_withdrawal_requests;
CREATE TRIGGER trg_realtime_admin_stats_payout
AFTER INSERT OR UPDATE OF status ON public.organizer_withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_admin_stats_payout();

-- Trigger: publish on every new signup (public.users is populated by the
-- handle_new_user() trigger right after a new auth.users row is created)
CREATE OR REPLACE FUNCTION public.notify_admin_stats_signup()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'admin:stats',
    'admin_stats_changed',
    jsonb_build_object('source', 'signup', 'id', NEW.id, 'created_at', NEW.created_at)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_realtime_admin_stats_signup ON public.users;
CREATE TRIGGER trg_realtime_admin_stats_signup
AFTER INSERT ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.notify_admin_stats_signup();
