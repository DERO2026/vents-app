-- ─────────────────────────────────────────────────────────────────────────
-- Pre-launch cleanup: remove placeholder/test event junk from the feed.
-- ─────────────────────────────────────────────────────────────────────────
-- Run manually via `npx @insforge/cli db query "$(cat scripts/01-cleanup-junk-events.sql)"`
-- or paste into the InsForge SQL console. NOT a schema migration — do not
-- add this to migrations/ or run it through `db migrations up` (that
-- pipeline is versioned schema history; this is a one-off data operation
-- you may want to re-run or adjust).
--
-- IMPORTANT — read before running: a naive "DELETE events WHERE title
-- looks like test junk" is NOT safe on this database. Checked directly
-- against production: some junk-titled events ALREADY have real, paid
-- ticket history attached (e.g. "Test payment final" has a genuine
-- Paystack-verified ₦106.60 payment on it). Deleting those would cascade-
-- delete real tickets and destroy financial audit history for money that
-- actually changed hands. This script only hard-deletes junk-titled events
-- with ZERO tickets ever created against them; anything with ticket
-- history gets soft-hidden instead (removed from the public feed, data
-- preserved).

-- ── Step 1: preview what will be touched (run this first, read the output) ──
SELECT
  e.id,
  e.title,
  e.organizer_id,
  count(t.id) AS ticket_count,
  count(*) FILTER (WHERE t.payment_status = 'paid') AS paid_count,
  CASE WHEN count(t.id) = 0 THEN 'WILL DELETE' ELSE 'WILL SOFT-HIDE (has ticket history)' END AS action
FROM public.events e
LEFT JOIN public.tickets t ON t.event_id = e.id
WHERE e.deleted_at IS NULL
  AND (
    lower(e.title) ~ '(^test|asdf|qwerty|^mock|placeholder|^untitled|^demo event|^sample|^lorem)'
    OR trim(e.title) = ''
  )
GROUP BY e.id, e.title, e.organizer_id
ORDER BY action, e.title;

-- ── Step 2: soft-hide junk-titled events that DO have ticket history ──
-- hidden_by_admin removes it from every public feed/search/event-details
-- lookup (same mechanism the admin "hide event" action already uses) while
-- keeping the row, its tickets, and its payment trail fully intact.
UPDATE public.events e
SET hidden_by_admin = true,
    hidden_at = now()
WHERE e.deleted_at IS NULL
  AND e.hidden_by_admin = false
  AND (
    lower(e.title) ~ '(^test|asdf|qwerty|^mock|placeholder|^untitled|^demo event|^sample|^lorem)'
    OR trim(e.title) = ''
  )
  AND EXISTS (SELECT 1 FROM public.tickets t WHERE t.event_id = e.id);

-- ── Step 3: hard-delete junk-titled events with NO ticket history ──
-- Safe: nothing real is attached. ON DELETE CASCADE on tickets.event_id
-- means this would also be safe even if a stray ticket appeared between
-- steps 1 and 3, but the WHERE clause below only ever targets zero-ticket
-- rows regardless.
DELETE FROM public.events e
WHERE e.deleted_at IS NULL
  AND (
    lower(e.title) ~ '(^test|asdf|qwerty|^mock|placeholder|^untitled|^demo event|^sample|^lorem)'
    OR trim(e.title) = ''
  )
  AND NOT EXISTS (SELECT 1 FROM public.tickets t WHERE t.event_id = e.id);

-- ── Step 4 (optional, review before running): genuinely empty/incomplete
-- drafts regardless of title — no image, no ticket types configured, no
-- description. These read as broken listings to a reviewer even with a
-- normal-looking title. Commented out deliberately: run the SELECT first
-- and eyeball the results, since this catches legitimate in-progress
-- organizer drafts too, not just abandoned junk.
--
-- SELECT id, title, organizer_id, created_at
-- FROM public.events
-- WHERE deleted_at IS NULL
--   AND image_url IS NULL
--   AND cover_url IS NULL
--   AND (ticket_types IS NULL OR ticket_types::text = '[]')
--   AND (description IS NULL OR trim(description) = '');
