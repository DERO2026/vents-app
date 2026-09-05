-- organizer_requests had NO server-side guard against a user submitting
-- more than one pending request -- unlike service_provider_requests, whose
-- admin_decide_service_provider_request sibling submit path already raises
-- 'You already have a pending request' (0044_service_provider_kyc.sql).
-- The organizer flow's only protection was ProfileScreen.tsx disabling the
-- "Become an Organizer" button once a pending request was known client-
-- side -- trivially bypassable (two tabs, a stale client, a direct insert)
-- and not a real guarantee. A partial unique index is the minimal, in-
-- architecture fix: at most one 'pending' row per user, enforced by
-- Postgres itself, no new RPC/system needed.
CREATE UNIQUE INDEX IF NOT EXISTS organizer_requests_one_pending_per_user
  ON public.organizer_requests (user_id)
  WHERE status = 'pending';
