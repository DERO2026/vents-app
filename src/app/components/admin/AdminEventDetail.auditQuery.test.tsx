import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Regression coverage for AdminEventDetail's Audit tab query:
//   supabase.from('admin_logs').select(...).eq('details->>event_id', eventId)...
//
// This syntax was flagged as unverified in the prior audit. What was
// actually established before writing this test (see the task report for
// full detail, summarized here since it's the premise this test builds on):
//
//   1. Live SQL semantics confirmed directly against the real VENTS database
//      via `EXPLAIN SELECT id FROM admin_logs WHERE details->>'event_id' = ...`
//      -- Postgres accepts and executes `details ->> 'event_id'` correctly
//      (confirmed with a real EXPLAIN plan, not assumed).
//   2. The installed @supabase/postgrest-js source (not memory/guesswork --
///     read directly from node_modules) types `.eq()`'s column parameter to
//      explicitly accept `${string}->${string}`, and its runtime body is
//      `this.url.searchParams.append(column, 'eq.'+value)` -- standard
//      URLSearchParams encoding handles the `->` characters safely, and the
//      type signature confirms this is the library's own intended,
//      first-class usage, not an unsupported accident.
//   3. A literal HTTP-level round trip against the live PostgREST endpoint
//      was attempted and blocked by this sandbox's egress network policy
//      (slrtjxtzhowhwhebjprv.supabase.co was refused by the agent proxy) --
//      so the exact wire-level request/response was NOT observed in this
//      task. That specific claim is NOT made anywhere in this file or the
//      accompanying report.
//
// This test's mock is a real predicate-applying query engine (same
// convention as AdminEventsList.search.test.tsx) -- it actually parses the
// `.eq('details->>event_id', id)` call and filters a fixture array by
// extracting details.event_id, instead of a mock that discards the
// arguments. It proves the COMPONENT sends the right filter and renders the
// right rows for a given mocked response; it does NOT prove PostgREST's
// real HTTP wire behavior (that would require the live round trip the
// network policy blocked, or an e2e/integration run outside this sandbox).

interface LogRow { id: string; action: string; details: Record<string, any>; created_at: string; actor_role: string | null; }

let logsData: LogRow[] = [];
let eventRow: any = null;
let forcedAuditError: string | null = null;

function makeEventsQuery() {
  const q: any = {
    select: () => q,
    eq: () => q,
    maybeSingle: () => Promise.resolve({ data: eventRow, error: null }),
  };
  return q;
}

function makeLogsQuery() {
  const predicates: Array<(r: LogRow) => boolean> = [];
  let limitN: number | undefined;
  const q: any = {
    select: () => q,
    eq: (col: string, val: any) => {
      // Mirrors what the real .eq('details->>event_id', id) call means:
      // compare the jsonb details column's 'event_id' key (as text) to val.
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
      if (forcedAuditError) {
        resolve({ data: null, error: { message: forcedAuditError } });
        return Promise.resolve();
      }
      let rows = logsData.filter((r) => predicates.every((p) => p(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      resolve({ data: rows, error: null });
      return Promise.resolve();
    },
  };
  return q;
}

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'events') return makeEventsQuery();
      if (table === 'admin_logs') return makeLogsQuery();
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

beforeEach(() => {
  eventRow = {
    id: 'e1', title: 'Afrobeats Night', organizer_id: 'o1', hidden_by_admin: false, hidden_at: null,
    created_at: '2026-03-01T00:00:00Z', event_date: '2026-04-01T00:00:00Z', location: 'Lagos', deleted_at: null,
    is_featured: false, featured_until: null, admin_trending: false,
    'users!events_organizer_id_fkey': { username: 'promoterco', full_name: 'Promoter Co', is_verified: true },
  };
  logsData = [
    { id: 'l1', action: 'hide_event', details: { event_id: 'e1', reason: 'policy' }, created_at: '2026-03-05T00:00:00Z', actor_role: 'admin' },
    { id: 'l2', action: 'feature_event', details: { event_id: 'e1', featured: true }, created_at: '2026-03-06T00:00:00Z', actor_role: 'admin' },
    { id: 'l3', action: 'hide_event', details: { event_id: 'other-event' }, created_at: '2026-03-07T00:00:00Z', actor_role: 'admin' },
  ];
  forcedAuditError = null;
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

describe('AdminEventDetail Audit tab: details->>event_id filter', () => {
  it('returns only the audit entries matching this event\'s id (the filter actually discriminates, not just "any rows")', async () => {
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-event-detail"]')!;
    await openAuditTab(el as HTMLElement);
    await flush();
    expect(el.textContent).toContain('hide event');
    expect(el.textContent).toContain('feature event');
    // l3 belongs to a different event_id and must be excluded.
    expect((el.textContent!.match(/hide event/g) || []).length).toBe(1);
  });

  it('shows the honest empty state when no audit entries match this event (not a false "entries exist" render)', async () => {
    logsData = logsData.map((r) => ({ ...r, details: { ...r.details, event_id: 'some-other-event' } }));
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-event-detail"]')!;
    await openAuditTab(el as HTMLElement);
    await flush();
    expect(el.textContent).toContain('No admin actions recorded for this event.');
  });

  it('a query error is currently swallowed to the same empty state as "no entries" -- documented current behavior, not asserted as good UX', async () => {
    forcedAuditError = 'relation admin_logs permission denied';
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-event-detail"]')!;
    await openAuditTab(el as HTMLElement);
    await flush();
    // Current behavior: the .catch(() => setAudit([])) in AdminEventDetail.tsx
    // means a real query error renders identically to "no admin actions
    // recorded" -- an admin cannot tell a failed audit fetch from a
    // genuinely clean history. This test locks in that this is what
    // happens today; it is not a statement that this is correct.
    expect(el.textContent).toContain('No admin actions recorded for this event.');
    expect(el.textContent).not.toContain('permission denied');
  });
});
