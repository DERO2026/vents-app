import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Regression coverage for AdminEventDetail's Audit tab: both the
// `.eq('details->>event_id', eventId)` filter itself, and its error
// handling.
//
// Filter syntax background (established in a prior task, not re-derived
// here): live SQL semantics were confirmed against the real VENTS database
// (`EXPLAIN SELECT ... WHERE details->>'event_id' = ...`), and the installed
// @supabase/postgrest-js source types `.eq()`'s column parameter to
// explicitly accept `${string}->${string}`, encoded via standard
// URLSearchParams. A literal HTTP round trip against the live PostgREST
// endpoint was attempted and blocked by this sandbox's network policy, so
// that specific claim is not made here either -- this file's mock proves
// the component sends the right filter and reacts correctly to a given
// mocked response, not PostgREST's real wire behavior.
//
// Error handling background (this task): the audit effect used to swallow
// any query error into the same empty state as "no admin actions recorded"
// (`.catch(() => setAudit([]))`). It now shows a distinct error message with
// a Retry button that reruns the same query, guarded against stale
// responses the same way AdminEventsList's search guards its own query.
//
// The mock below is a real predicate-applying query engine (same
// convention as AdminEventsList.search.test.tsx) with manual, test-
// controlled resolution (same convention as that file's stale-response
// test) -- not a mock that discards arguments or auto-resolves instantly,
// so the stale-response and retry assertions are deterministic rather than
// timing-dependent.

interface LogRow { id: string; action: string; details: Record<string, any>; created_at: string; actor_role: string | null; }

let logsData: LogRow[] = [];
let eventRows: Record<string, any> = {};
let forcedAuditError: string | null = null;
let manualMode = false;
let logsCallCount = 0;
const manualResolvers: Record<number, () => void> = {};
function resolveLogsCall(n: number) {
  const fn = manualResolvers[n];
  if (!fn) throw new Error(`No pending manual resolver for admin_logs call #${n}`);
  delete manualResolvers[n];
  fn();
}

function makeEventsQuery() {
  let idFilter: string | undefined;
  const q: any = {
    select: () => q,
    eq: (col: string, val: any) => { if (col === 'id') idFilter = val; return q; },
    maybeSingle: () => Promise.resolve({ data: (idFilter && eventRows[idFilter]) || null, error: null }),
  };
  return q;
}

function makeLogsQuery() {
  const predicates: Array<(r: LogRow) => boolean> = [];
  let limitN: number | undefined;
  const q: any = {
    select: () => q,
    eq: (col: string, val: any) => {
      const match = col.match(/^details->>(.+)$/);
      if (match) {
        const key = match[1];
        predicates.push((r) => String(r.details?.[key] ?? '') === String(val));
      } else {
        predicates.push((r: any) => r[col] === val);
      }
      return q;
    },
    order: () => q,
    limit: (n: number) => { limitN = n; return q; },
    then: (resolve: any) => {
      logsCallCount += 1;
      const callIndex = logsCallCount;
      const run = () => {
        if (forcedAuditError) {
          resolve({ data: null, error: { message: forcedAuditError } });
          return;
        }
        let rows = logsData.filter((r) => predicates.every((p) => p(r)));
        if (limitN != null) rows = rows.slice(0, limitN);
        resolve({ data: rows, error: null });
      };
      if (manualMode) manualResolvers[callIndex] = run;
      else Promise.resolve().then(run);
      return Promise.resolve();
    },
  };
  return q;
}

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'admin_logs') return makeLogsQuery();
      if (table === 'events') return makeEventsQuery();
      throw new Error(`unexpected table in test: ${table}`);
    },
    rpc: (name: string) => {
      if (name === 'get_event_analytics') {
        return Promise.resolve({ data: { overview: { soldCount: 0, soldQuantity: 0, grossKobo: 0, pendingCount: 0, cancelledCount: 0, refundedCount: 0 }, attendance: { checkedInCount: 0, soldQuantity: 0, attendancePct: null } }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import { AdminEventDetail } from './AdminEventDetail';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const admin = { id: 'admin-1', role: 'admin' };

function eventFixture(id: string, title: string) {
  return {
    id, title, organizer_id: 'o1', hidden_by_admin: false, hidden_at: null,
    created_at: '2026-03-01T00:00:00Z', event_date: '2026-04-01T00:00:00Z', location: 'Lagos', deleted_at: null,
    is_featured: false, featured_until: null, admin_trending: false,
    'users!events_organizer_id_fkey': { username: 'promoterco', full_name: 'Promoter Co', is_verified: true },
  };
}

beforeEach(() => {
  eventRows = { e1: eventFixture('e1', 'Afrobeats Night'), e2: eventFixture('e2', 'Jazz Evening') };
  logsData = [
    { id: 'l1', action: 'hide_event', details: { event_id: 'e1', reason: 'policy' }, created_at: '2026-03-05T00:00:00Z', actor_role: 'admin' },
    { id: 'l2', action: 'feature_event', details: { event_id: 'e1', featured: true }, created_at: '2026-03-06T00:00:00Z', actor_role: 'admin' },
    { id: 'l3', action: 'hide_event', details: { event_id: 'e2' }, created_at: '2026-03-07T00:00:00Z', actor_role: 'admin' },
  ];
  forcedAuditError = null;
  manualMode = false;
  logsCallCount = 0;
  for (const k of Object.keys(manualResolvers)) delete manualResolvers[Number(k)];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openAuditTab(el: HTMLElement) {
  const auditTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Audit') as HTMLElement;
  return act(async () => { auditTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function getDetailEl(): HTMLElement {
  return container!.querySelector('[data-testid="admin-event-detail"]')!;
}

describe('AdminEventDetail Audit tab: details->>event_id filter', () => {
  it('returns only the audit entries matching this event\'s id', async () => {
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl());
    await flush();
    const el = getDetailEl();
    expect(el.textContent).toContain('hide event');
    expect(el.textContent).toContain('feature event');
    expect((el.textContent!.match(/hide event/g) || []).length).toBe(1); // l3 (event e2) excluded
  });

  it('shows the honest empty state for a genuinely empty history', async () => {
    logsData = logsData.filter((r) => r.details.event_id !== 'e1');
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl());
    await flush();
    expect(getDetailEl().textContent).toContain('No admin actions recorded for this event.');
  });
});

describe('AdminEventDetail Audit tab: error handling', () => {
  it('shows a distinct error message on query failure, not the empty-state text', async () => {
    forcedAuditError = 'relation admin_logs permission denied';
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl());
    await flush();
    const el = getDetailEl();
    expect(el.textContent).toContain('Unable to load admin activity. Please try again.');
    expect(el.textContent).not.toContain('No admin actions recorded for this event.');
  });

  it('retry reruns the query and succeeds once the failure clears', async () => {
    forcedAuditError = 'temporary failure';
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl());
    await flush();
    expect(getDetailEl().textContent).toContain('Unable to load admin activity. Please try again.');

    forcedAuditError = null;
    const retryBtn = Array.from(getDetailEl().querySelectorAll('button')).find((b) => b.textContent === 'Retry') as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();
    await act(async () => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const el = getDetailEl();
    expect(el.textContent).toContain('hide event');
    expect(el.textContent).not.toContain('Unable to load admin activity');
  });

  it('a slower, superseded load does not overwrite a newer one (stale-response guard, via leaving and reopening the Audit tab while the first load is still pending)', async () => {
    manualMode = true;
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl()); // call #1, pending (manual mode)
    await flush();
    expect(getDetailEl().textContent).toContain('Loading audit trail…');

    // Leave the Audit tab and come back before call #1 resolves -- this is
    // the real, reachable way a second overlapping load happens (the Retry
    // button itself isn't even rendered while a load is in flight, so two
    // overlapping *retries* specifically aren't reachable through this UI;
    // tab-away-and-back is).
    const overviewTab = Array.from(getDetailEl().querySelectorAll('div')).find((d) => d.textContent === 'Overview') as HTMLElement;
    await act(async () => { overviewTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    await openAuditTab(getDetailEl()); // call #2, also pending
    await flush();
    expect(getDetailEl().textContent).toContain('Loading audit trail…');

    // Resolve the newer call (#2) successfully first.
    resolveLogsCall(2);
    await flush();
    expect(getDetailEl().textContent).toContain('hide event');

    // The older, slower call (#1) finally resolves as a failure -- it must
    // be dropped as stale, not overwrite the already-successful state from
    // call #2 with an error.
    forcedAuditError = 'stale failure';
    resolveLogsCall(1);
    await flush();
    const el = getDetailEl();
    expect(el.textContent).toContain('hide event');
    expect(el.textContent).not.toContain('Unable to load admin activity');
  });

  it('switching to a different event does not let the previous event\'s in-flight audit response overwrite the new event\'s state', async () => {
    manualMode = true;
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl()); // call #1 for e1, pending
    await flush();

    // Switch to a different event while e1's audit call is still pending.
    await act(async () => { root!.render(<AdminEventDetail eventId="e2" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await openAuditTab(getDetailEl()); // call #2 for e2, pending
    await flush();

    resolveLogsCall(2); // e2's own call resolves
    await flush();
    const el = getDetailEl();
    expect(el.textContent).toContain('hide event'); // l3 belongs to e2

    // e1's stale call (#1) resolves last -- must not clobber e2's state.
    resolveLogsCall(1);
    await flush();
    expect(getDetailEl().textContent).toContain('hide event');
  });
});
