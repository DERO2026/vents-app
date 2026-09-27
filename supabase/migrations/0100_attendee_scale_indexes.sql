-- Large-event scalability audit (5,000-50,000 attendees, multiple
-- simultaneous scanners) found two query shapes against `tickets` with no
-- supporting index:
--
-- 1. get_event_attendees (0004_functions.sql) -- backs both
--    AttendeeListScreen.tsx and the Door Manager guest list --
--    `WHERE event_id = $1 ... ORDER BY checked_in_at DESC NULLS LAST,
--    created_at DESC LIMIT/OFFSET`. Only idx_tickets_event_id covers the
--    WHERE; the ORDER BY has no supporting index, so every OFFSET-paginated
--    page re-sorts the event's full row set in memory. At 20,000-50,000
--    tickets for one event this means increasingly expensive per-page reads
--    as an organizer/door-staff scrolls deeper into the list.
--
-- 2. get_event_ticket_stats / get_event_analytics (dashboard aggregates)
--    and PortfolioAnalyticsScreen.tsx's raw ticket query all filter on
--    `event_id` + `status` + `payment_status` together with no composite
--    index -- Postgres index-scans on event_id alone then filters the rest
--    row-by-row.
--
-- Plain (non-CONCURRENTLY) CREATE INDEX, matching this repo's existing
-- convention (see 0086_referral_rate_limit_and_vc_dedup.sql's own note:
-- apply_migration runs inside a transaction, and CREATE INDEX CONCURRENTLY
-- cannot run inside one). The live `tickets` table is small today, so the
-- brief write-lock this takes is not a concern; revisit before a
-- production event where a lock is unacceptable.

CREATE INDEX IF NOT EXISTS idx_tickets_event_checkedin_created
  ON public.tickets (event_id, checked_in_at DESC NULLS LAST, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_event_status_payment
  ON public.tickets (event_id, status, payment_status);
