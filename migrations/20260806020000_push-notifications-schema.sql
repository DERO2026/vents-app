-- Foundation for real FCM push delivery. Until now, INSERT INTO
-- public.notifications only ever populated the in-app bell list —
-- api/push/send.ts (the only code that actually calls Firebase) is a
-- super-admin-only, single-user-at-a-time endpoint, never wired to any of
-- these inserts. This adds the columns a new cron worker
-- (api/cron/send-pending-pushes.ts) needs to find "notifications that still
-- need a real push sent" and know where to deep-link the tap to.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS push_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS push_data jsonb;

-- The cron worker's main query is "WHERE push_sent = false" across every
-- user — without this index that's a full table scan on a table that's
-- otherwise indexed for per-user reads only.
CREATE INDEX IF NOT EXISTS idx_notifications_push_pending
  ON public.notifications (created_at)
  WHERE push_sent = false;

-- Widen the notification-type vocabulary. The original four buckets
-- ('reminder','booking','promo','social') don't cleanly cover "new direct
-- message", "you made a sale", or "event details changed" — forcing those
-- into 'social'/'booking' would make NotificationsScreen's type-based
-- icon/grouping logic misleading. ALTER TABLE ... DROP/ADD CONSTRAINT is the
-- only way to widen a CHECK short of recreating the column.
-- 'broadcast' is already live in production (admin broadcast feature) but
-- wasn't in any CHECK constraint definition found in migration history —
-- confirmed via `db query "SELECT DISTINCT type FROM notifications"`
-- against the actual database before writing this, not assumed from the
-- migration files alone.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('reminder', 'booking', 'promo', 'social', 'broadcast', 'message', 'sale', 'event_update'));

-- notify_user gains an optional push_data payload so callers can attach a
-- deep-link target (eventId/userId/screen — the same shape App.tsx's
-- pushActionRef already parses) without every caller needing to know about
-- push delivery at all; it's just another column on the same INSERT.
-- Re-applies the project_admin-only lockdown from
-- 20260731201827_lockdown-vc-notify-cron-rpcs.sql since CREATE OR REPLACE
-- does not preserve a prior REVOKE/GRANT.
CREATE OR REPLACE FUNCTION public.notify_user(
  p_user_id   UUID,
  p_type      TEXT,
  p_title     TEXT,
  p_body      TEXT,
  p_icon      TEXT DEFAULT '🔔',
  p_push_data JSONB DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
  VALUES (p_user_id, p_type, p_title, p_body, p_icon, p_push_data);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text, jsonb) TO project_admin;

-- Note: Postgres identifies a function by name + parameter TYPE list, so
-- this 6-arg version is a genuinely separate overload from the existing
-- 5-arg notify_user(uuid, text, text, text, text) — CREATE OR REPLACE does
-- not touch or remove that one. Every existing caller of the 5-arg form
-- keeps working unchanged (still project_admin-only, same as before); new
-- code that wants a push deep-link calls this 6-arg form instead.
