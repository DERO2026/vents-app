import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventEffectiveEndAt, hasEventEnded, isEventActive, isEventDiscoverable } from './eventLifecycle';

// Regression tests for the expired-event lifecycle fix: one canonical
// definition of "has this event ended" (mirrored server-side in
// supabase/migrations/0051_event_lifecycle_single_source_of_truth.sql and
// client-side in eventLifecycle.ts) applied to every discovery/purchase
// path. Real unit tests against the actual TS logic where the helper is
// pure functions; static-analysis checks (matching this repo's convention
// for SQL/component wiring, which has no live-DB test harness) for the
// server functions and the screens that must call into it.

let m0051: string;
let appSrc: string;
let homeScreenSrc: string;
let eventDetailsSrc: string;
let cronRunSrc: string;

beforeAll(() => {
  m0051 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0051_event_lifecycle_single_source_of_truth.sql'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  homeScreenSrc = readFileSync(join(componentsDir, 'HomeScreen.tsx'), 'utf8');
  eventDetailsSrc = readFileSync(join(componentsDir, 'EventDetailsScreen.tsx'), 'utf8');
  cronRunSrc = readFileSync(join(__dirname, '..', '..', 'api', 'cron', 'run.ts'), 'utf8');
});

const NOW = new Date('2026-09-05T12:00:00Z');

describe('eventLifecycle helpers (client-side single source of truth)', () => {
  it('an active event (starts in the future) is discoverable and purchasable', () => {
    const e = { event_date: '2026-09-10T18:00:00Z', end_date: null, status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: null };
    expect(hasEventEnded(e, NOW)).toBe(false);
    expect(isEventActive(e, NOW)).toBe(true);
    expect(isEventDiscoverable(e, NOW)).toBe(true);
  });

  it('an event with no end_date is still active within 24h of its start', () => {
    const e = { event_date: '2026-09-05T06:00:00Z', end_date: null, status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: null };
    // started 6h ago, no explicit end_date -> effective end is start+24h, still in the future
    expect(hasEventEnded(e, NOW)).toBe(false);
    expect(isEventDiscoverable(e, NOW)).toBe(true);
  });

  it('an event that started and passed its 24h fallback window has ended -- the exact bug reported (same-day ended event still purchasable)', () => {
    const e = { event_date: '2026-09-01T06:00:00Z', end_date: null, status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: null };
    expect(hasEventEnded(e, NOW)).toBe(true);
    expect(isEventActive(e, NOW)).toBe(false);
    expect(isEventDiscoverable(e, NOW)).toBe(false);
  });

  it('an explicit end_date is authoritative over the 24h fallback -- a multi-day event stays active past its start+24h', () => {
    const e = { event_date: '2026-09-01T06:00:00Z', end_date: '2026-09-10T06:00:00Z', status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: null };
    expect(hasEventEnded(e, NOW)).toBe(false);
    expect(isEventDiscoverable(e, NOW)).toBe(true);
  });

  it('an explicit end_date in the past ends the event even if within 24h of start', () => {
    const e = { event_date: '2026-09-05T00:00:00Z', end_date: '2026-09-05T10:00:00Z', status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: null };
    expect(hasEventEnded(e, NOW)).toBe(true);
  });

  it('exact boundary: now() strictly equal to the effective end counts as ended', () => {
    const endAt = new Date('2026-09-05T12:00:00Z');
    const e = { event_date: '2026-09-04T12:00:00Z', end_date: endAt.toISOString(), status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: null };
    expect(eventEffectiveEndAt(e.event_date, e.end_date).getTime()).toBe(endAt.getTime());
    expect(hasEventEnded(e, NOW)).toBe(true); // now >= end
    expect(hasEventEnded(e, new Date(endAt.getTime() - 1))).toBe(false);
  });

  it('an active event is not discoverable/purchasable once hidden by admin, deleted, or non-live', () => {
    const base = { event_date: '2026-09-10T18:00:00Z', end_date: null, archived_at: null };
    expect(isEventActive({ ...base, status: 'live', hidden_by_admin: true, deleted_at: null }, NOW)).toBe(false);
    expect(isEventActive({ ...base, status: 'live', hidden_by_admin: false, deleted_at: new Date().toISOString() }, NOW)).toBe(false);
    expect(isEventActive({ ...base, status: 'draft', hidden_by_admin: false, deleted_at: null }, NOW)).toBe(false);
  });

  it('a discoverable event stops being discoverable once archived, even if still time-active', () => {
    const e = { event_date: '2026-09-10T18:00:00Z', end_date: null, status: 'live', hidden_by_admin: false, deleted_at: null, archived_at: '2026-09-05T00:00:00Z' };
    expect(isEventActive(e, NOW)).toBe(true);
    expect(isEventDiscoverable(e, NOW)).toBe(false);
  });
});

describe('server-side purchase guards use the canonical effective-end function (requirement #10)', () => {
  it('event_effective_end_at / event_is_active are defined as the single canonical predicate', () => {
    expect(m0051).toMatch(/CREATE OR REPLACE FUNCTION public\.event_effective_end_at/);
    expect(m0051).toMatch(/SELECT COALESCE\(p_end_date, p_event_date \+ interval '24 hours'\);/);
    expect(m0051).toMatch(/CREATE OR REPLACE FUNCTION public\.event_is_active/);
  });

  it('finalize_pending_purchase (paid-ticket path) rejects purchase using event_effective_end_at, not a date-only comparison', () => {
    const fn = m0051.match(/CREATE OR REPLACE FUNCTION public\.finalize_pending_purchase[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/event_date, end_date, hidden_by_admin/);
    expect(fn).toMatch(/IF now\(\) >= public\.event_effective_end_at\(v_event\.event_date, v_event\.end_date\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'This event has already ended';/);
    expect(fn).not.toMatch(/event_date::date < current_date/);
  });

  it('purchase_ticket (free/VC-discounted path, also used by purchase_ticket_with_tokens) carries the same guard', () => {
    const fn = m0051.match(/CREATE OR REPLACE FUNCTION public\.purchase_ticket\(p_event_id[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/event_date, end_date, hidden_by_admin/);
    expect(fn).toMatch(/IF now\(\) >= public\.event_effective_end_at\(v_event\.event_date, v_event\.end_date\) THEN/);
    expect(fn).not.toMatch(/event_date::date < current_date/);
  });
});

describe('7-day archival sweep (requirement #7, #8, #9, #11)', () => {
  it('adds a soft archived_at marker column rather than deleting rows', () => {
    expect(m0051).toMatch(/ALTER TABLE public\.events ADD COLUMN IF NOT EXISTS archived_at timestamptz;/);
  });

  it('archive_ended_events() only archives rows more than 7 days past their effective end, and is idempotent (archived_at IS NULL guard)', () => {
    const fn = m0051.match(/CREATE OR REPLACE FUNCTION public\.archive_ended_events\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).toMatch(/WHERE archived_at IS NULL/);
    expect(fn).toMatch(/now\(\) >= public\.event_effective_end_at\(event_date, end_date\) \+ interval '7 days'/);
    expect(fn).not.toMatch(/DELETE FROM/);
  });

  it('does not touch tickets/payments/check-ins/transfers/analytics tables', () => {
    const fn = m0051.match(/CREATE OR REPLACE FUNCTION public\.archive_ended_events\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fn).not.toMatch(/public\.tickets/);
    expect(fn).not.toMatch(/public\.payments/);
    expect(fn).not.toMatch(/public\.check_?ins/);
    expect(fn).not.toMatch(/public\.ticket_transfers/);
  });

  it('is wired into the EXISTING daily cron, not a new hourly one (Vercel Hobby caps cron frequency at daily)', () => {
    expect(cronRunSrc).toMatch(/callProjectAdminRpc<number>\('archive_ended_events', \[\]\)/);
    expect(cronRunSrc).not.toMatch(/vercel\.json.*hourly/i);
  });
});

describe('client-side discovery surfaces apply the same rule (requirements #1, #2, #4)', () => {
  it('App.tsx fetchEvents no longer uses the flawed date-only filter, and applies isEventDiscoverable client-side', () => {
    expect(appSrc).not.toMatch(/\.gte\('event_date', new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\)/);
    expect(appSrc).toMatch(/import \{ isEventDiscoverable \} from '\.\.\/lib\/eventLifecycle';/);
    expect(appSrc).toMatch(/dbEventsData\.filter\(\(e: any\) => isEventDiscoverable\(e\)\)/);
    expect(appSrc).toMatch(/\.is\('archived_at', null\)/);
  });

  it('HomeScreen.tsx internal events query (Explore/Search/Trending/Featured all source from it) no longer uses the flawed date-only filter', () => {
    expect(homeScreenSrc).not.toMatch(/\.gte\('event_date', new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]\)/);
    expect(homeScreenSrc).toMatch(/import \{ isEventDiscoverable \} from '\.\.\/\.\.\/lib\/eventLifecycle';/);
    expect(homeScreenSrc).toMatch(/rawData\.filter\(\(e: any\) => isEventDiscoverable\(e\)\)/);
  });

  it('EventDetailsScreen shows "Event Ended" with no purchase CTA once the event has ended', () => {
    expect(eventDetailsSrc).toMatch(/const hasEnded = hasEventEnded/);
    expect(eventDetailsSrc).toMatch(/Event Ended/);
    expect(eventDetailsSrc).toMatch(/const canBook = !hasEnded && !!selectedTicket && selectedQty > 0;/);
  });

  it('Related Events query excludes ended events', () => {
    const block = eventDetailsSrc.match(/const fetchRelatedEvents[\s\S]*?fetchRelatedEvents\(\);/)?.[0] ?? '';
    expect(block).toMatch(/isEventDiscoverable\(e\)/);
    expect(block).toMatch(/\.is\('archived_at', null\)/);
  });
});

describe('organizer/admin access to ended events is preserved (requirements #5, #6)', () => {
  it('select_events RLS is not modified by this migration -- ended events stay visible to their organizer/admin/ticket-holders', () => {
    expect(m0051).not.toMatch(/CREATE POLICY select_events/);
    expect(m0051).not.toMatch(/DROP POLICY.*select_events/);
  });

  it('archived_at is not referenced by the RLS policy file, so archiving never hides an event from its organizer/admin', () => {
    const rls = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0008_rls_and_policies.sql'), 'utf8');
    expect(rls).not.toMatch(/archived_at/);
  });
});
