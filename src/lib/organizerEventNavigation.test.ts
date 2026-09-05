import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for two Preview bugs found after the event-lifecycle fix
// (see src/lib/eventLifecycle.test.ts for that fix's own tests):
//
// 1. Tapping an ended event in OrganizerDashboard's Past Events tab could
//    open a DIFFERENT, unrelated (often live) event instead. Root cause:
//    App.tsx's onEventPress for OrganizerDashboard tried to "upgrade" the
//    tapped row to the richer mapped Event from `dbEvents` (the public Home
//    feed) by id lookup, but did nothing on a lookup miss -- and since
//    dbEvents now (correctly) excludes ended/draft/hidden events, EVERY
//    ended event tap was a miss. `setSelectedEvent` was never called, so
//    `selectedEvent` kept whatever it was previously (the last event the
//    user had open), yet navigateTo('event-details') still fired --
//    showing that stale, unrelated event instead of the one just tapped.
//
// 2. OrganizerDashboard's own Live/Drafts/Past tab split used a bespoke,
//    local-midnight, start-date-only comparison (ignoring end_date
//    entirely) instead of the canonical event lifecycle rule established
//    in supabase/migrations/0051 and src/lib/eventLifecycle.ts -- and the
//    status badge on each row displayed the raw DB `status` column ('live'
//    is the *published* state, not "has this event ended"), so a
//    correctly-Past-tab-sorted event still showed a green "LIVE" badge.

let appSrc: string;
let orgDashboardSrc: string;

beforeAll(() => {
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  orgDashboardSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'OrganizerDashboard.tsx'), 'utf8');
});

describe('Issue 1: selecting an event in OrganizerDashboard always opens THAT event', () => {
  it('onEventPress always calls setSelectedEvent, with a mapDbEventToFrontend fallback for events missing from dbEvents (ended/draft/not yet paginated in)', () => {
    const block = appSrc.match(/onEventPress=\{\(event\) => \{[\s\S]*?navigateTo\('event-details'\);\s*\}\}/)?.[0] ?? '';
    expect(block).toMatch(/const mapped = dbEvents\.find\(e => e\.id === event\.id\);/);
    expect(block).toMatch(/setSelectedEvent\(mapped \|\| mapDbEventToFrontend\(event\)\);/);
    // The old bug pattern: `if (mapped) setSelectedEvent(mapped);` with no
    // else branch, silently leaving selectedEvent untouched on a miss.
    expect(block).not.toMatch(/if \(mapped\) setSelectedEvent\(mapped\);\s*\n\s*navigateTo/);
  });
});

describe('Issue 2: OrganizerDashboard Live/Drafts/Past tabs use the canonical event lifecycle rule', () => {
  it('imports the shared hasEventEnded helper instead of a bespoke date check', () => {
    expect(orgDashboardSrc).toMatch(/import \{ hasEventEnded \} from '\.\.\/\.\.\/lib\/eventLifecycle';/);
  });

  it('Live tab excludes ended events; Past tab only contains ended events; Drafts unaffected', () => {
    const block = orgDashboardSrc.match(/const ended = \(e: any\)[\s\S]*?: orgEvents\.filter\(e => getStatus\(e\) !== 'draft' && ended\(e\)\);/)?.[0] ?? '';
    expect(block).toMatch(/const ended = \(e: any\) => hasEventEnded\(\{ event_date: e\.event_date, end_date: e\.end_date \?\? null \}\);/);
    expect(block).toMatch(/activeTab === 'live'\s*\n\s*\? orgEvents\.filter\(e => getStatus\(e\) !== 'draft' && !ended\(e\)\)/);
    expect(block).toMatch(/: orgEvents\.filter\(e => getStatus\(e\) !== 'draft' && ended\(e\)\);/);
    // The old bug: a bare start-date-vs-local-midnight comparison that
    // ignored end_date and could misclassify a same-day-ended or
    // still-ongoing multi-day event.
    expect(orgDashboardSrc).not.toMatch(/new Date\(e\.event_date\) >= todayStart/);
    expect(orgDashboardSrc).not.toMatch(/new Date\(e\.event_date\) < todayStart/);
  });

  it('the status badge shows "ended" for events in the Past tab instead of the raw (misleading) DB status', () => {
    expect(orgDashboardSrc).toMatch(/const badgeLabel = ended\(event\) \? 'ended' : getStatus\(event\);/);
    expect(orgDashboardSrc).toMatch(/\{badgeLabel\}/);
    // The old bug: badging every row with the raw `status` column, so a
    // Past-tab row (still status='live' in the DB, meaning "published" not
    // "ended") displayed a green "LIVE" tag.
    expect(orgDashboardSrc).not.toMatch(/\{getStatus\(event\)\}\s*\n\s*<\/span>/);
  });
});
