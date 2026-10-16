import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Regression coverage for the Events list's title search (the confirmed
// missing-search gap from the Oct 2026 audit). Unlike
// AdminUsersEvents.render.test.tsx's events mock (`select: () => q`, which
// discards every filter argument and always returns the same fixture), this
// mock is a real, if tiny, query engine: it tracks every .eq/.not/.is/.ilike
// predicate actually chained and applies it to the fixture array before
// resolving, the same way PostgREST would apply them server-side. A test
// here can therefore only pass if the component actually sent the right
// predicates -- a search `.ilike('title', ...)` that silently wasn't
// chained, or a filter clause dropped when combined with search, would show
// up as wrong rows rendered, not as a passing assertion against a mock that
// never looked at its arguments.

const rpcCalls: { name: string; args?: any }[] = [];

interface Row {
  id: string; title: string; organizer_id: string; hidden_by_admin: boolean; hidden_at: string | null;
  created_at: string; event_date: string | null; deleted_at: string | null; is_featured: boolean;
  featured_until: string | null; admin_trending: boolean; image_url: string | null;
}

let eventsData: Row[] = [];
let queryCallCount = 0;
let forcedError: string | null = null;
// When true, a query's resolution is NOT scheduled automatically -- the
// test must call resolveCall(n) itself. This gives exact, race-free control
// over which of two overlapping requests resolves first, instead of
// guessing at setTimeout delays against the real debounce timer.
let manualMode = false;
const manualResolvers: Record<number, () => void> = {};
function resolveCall(n: number) {
  const fn = manualResolvers[n];
  if (!fn) throw new Error(`No pending manual resolver for call #${n}`);
  delete manualResolvers[n];
  fn();
}

function unescapeIlikePattern(pattern: string): string {
  // Strips the leading/trailing '%' wildcards AdminEventsList always wraps
  // the term in, then un-escapes \%, \_, \,, \\ back to their literal chars
  // -- mirroring what a real ilike engine does with the escaped pattern the
  // component sends.
  const core = pattern.replace(/^%/, '').replace(/%$/, '');
  return core.replace(/\\([\\%_,])/g, '$1');
}

function makeEventsQuery() {
  const state = {
    rows: eventsData,
    predicates: [] as Array<(r: Row) => boolean>,
    limitN: undefined as number | undefined,
  };
  const q: any = {
    select: () => q,
    order: () => q,
    limit: (n: number) => { state.limitN = n; return q; },
    eq: (col: string, val: any) => { state.predicates.push((r: any) => r[col] === val); return q; },
    not: (col: string, _op: string, val: any) => {
      // AdminEventsList only ever calls .not('deleted_at', 'is', null) here.
      state.predicates.push((r: any) => (val === null ? r[col] != null : r[col] !== val));
      return q;
    },
    is: (col: string, val: any) => {
      state.predicates.push((r: any) => (val === null ? r[col] == null : r[col] === val));
      return q;
    },
    ilike: (col: string, pattern: string) => {
      const needle = unescapeIlikePattern(pattern).toLowerCase();
      state.predicates.push((r: any) => String(r[col] ?? '').toLowerCase().includes(needle));
      return q;
    },
    then: (resolve: any, _reject: any) => {
      queryCallCount += 1;
      const callIndex = queryCallCount;
      const run = () => {
        if (forcedError) {
          resolve({ data: null, error: { message: forcedError } });
          return;
        }
        let rows = state.rows.filter((r) => state.predicates.every((p) => p(r)));
        if (state.limitN != null) rows = rows.slice(0, state.limitN);
        resolve({
          data: rows.map((r) => ({ ...r, 'users!events_organizer_id_fkey': { username: 'promoterco', full_name: 'Promoter Co', is_verified: true } })),
          error: null,
        });
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
      if (table === 'events') return makeEventsQuery();
      return { select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    },
    rpc: (name: string, args?: any) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import { AdminEventsList } from './AdminEventsList';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const admin = { id: 'admin-1', role: 'admin' };

function freshFixture(): Row[] {
  return [
    { id: 'e1', title: 'Afrobeats Night', organizer_id: 'o1', hidden_by_admin: false, hidden_at: null, created_at: '2026-03-01T00:00:00Z', event_date: '2026-04-01T00:00:00Z', deleted_at: null, is_featured: false, featured_until: null, admin_trending: false, image_url: null },
    { id: 'e2', title: 'Jazz Evening', organizer_id: 'o2', hidden_by_admin: true, hidden_at: '2026-03-02T00:00:00Z', created_at: '2026-03-02T00:00:00Z', event_date: '2026-04-02T00:00:00Z', deleted_at: null, is_featured: false, featured_until: null, admin_trending: false, image_url: null },
    { id: 'e3', title: 'Deleted Fest', organizer_id: 'o3', hidden_by_admin: false, hidden_at: null, created_at: '2026-03-03T00:00:00Z', event_date: '2026-04-03T00:00:00Z', deleted_at: '2026-03-10T00:00:00Z', is_featured: false, featured_until: null, admin_trending: false, image_url: null },
    { id: 'e4', title: 'Featured Gala', organizer_id: 'o4', hidden_by_admin: false, hidden_at: null, created_at: '2026-03-04T00:00:00Z', event_date: '2026-04-04T00:00:00Z', deleted_at: null, is_featured: true, featured_until: null, admin_trending: false, image_url: null },
    { id: 'e5', title: 'Trending Rave', organizer_id: 'o5', hidden_by_admin: false, hidden_at: null, created_at: '2026-03-05T00:00:00Z', event_date: '2026-04-05T00:00:00Z', deleted_at: null, is_featured: false, featured_until: null, admin_trending: true, image_url: null },
  ];
}

beforeEach(() => {
  eventsData = freshFixture();
  queryCallCount = 0;
  manualMode = false;
  for (const k of Object.keys(manualResolvers)) delete manualResolvers[Number(k)];
  forcedError = null;
  rpcCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

async function flushDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320)); // past SEARCH_DEBOUNCE_MS
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getInput(): HTMLInputElement {
  return container!.querySelector('input[aria-label="Search events by title"]') as HTMLInputElement;
}

function typeSearch(value: string) {
  const input = getInput();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AdminEventsList search', () => {
  it('matches an event by title', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Night');
    expect(container!.textContent).not.toContain('Featured Gala');
  });

  it('matches case-insensitively', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    typeSearch('afROBEats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Night');
  });

  it('shows a clear "no matches" state for a search that matches nothing, distinct from the plain empty state', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    typeSearch('Nonexistent Event Name');
    await flushDebounce();
    expect(container!.textContent).toContain('No events found for "Nonexistent Event Name".');
    expect(container!.textContent).not.toContain('Afrobeats Night');
  });

  it('clearing the search (via the clear button) restores the unfiltered list', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).not.toContain('Jazz Evening');

    const clearBtn = container!.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement;
    expect(clearBtn).toBeTruthy();
    await act(async () => { clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flushDebounce();
    expect(getInput().value).toBe('');
    expect(container!.textContent).toContain('Afrobeats Night');
    expect(container!.textContent).toContain('Jazz Evening');
  });

  it('combines search with the Active filter (default) -- deleted events are excluded even if their title matches (Active means "not deleted", and does include hidden events, matching the pre-existing filter semantics unchanged by this feature)', async () => {
    eventsData[2].title = 'Afrobeats Deleted Fest'; // deleted, would match "Afrobeats" by title alone
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Night'); // active, matches
    expect(container!.textContent).not.toContain('Afrobeats Deleted Fest'); // deleted, excluded by Active filter
  });

  it('combines search with the Hidden filter', async () => {
    eventsData[1].title = 'Afrobeats Jazz Evening';
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    const hiddenChip = Array.from(container!.querySelectorAll('div')).find((d) => d.textContent === 'hidden') as HTMLElement;
    await act(async () => { hiddenChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Jazz Evening');
    expect(container!.textContent).not.toContain('Afrobeats Night'); // active-only, excluded by Hidden filter
  });

  it('combines search with the Deleted filter', async () => {
    eventsData[2].title = 'Afrobeats Deleted Fest';
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    const deletedChip = Array.from(container!.querySelectorAll('div')).find((d) => d.textContent === 'deleted') as HTMLElement;
    await act(async () => { deletedChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Deleted Fest');
    expect(container!.textContent).not.toContain('Afrobeats Night');
  });

  it('combines search with the Featured filter', async () => {
    eventsData[3].title = 'Afrobeats Featured Gala';
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    const featuredChip = Array.from(container!.querySelectorAll('div')).find((d) => d.textContent === 'featured') as HTMLElement;
    await act(async () => { featuredChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Featured Gala');
    expect(container!.textContent).not.toContain('Afrobeats Night');
  });

  it('combines search with the Trending filter', async () => {
    eventsData[4].title = 'Afrobeats Trending Rave';
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    const trendingChip = Array.from(container!.querySelectorAll('div')).find((d) => d.textContent === 'trending') as HTMLElement;
    await act(async () => { trendingChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flushDebounce();
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Afrobeats Trending Rave');
    expect(container!.textContent).not.toContain('Afrobeats Night');
  });

  it('shows a loading state while the search query is in flight', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce(); // call #1 (initial unfiltered load) resolves automatically

    manualMode = true;
    typeSearch('Afrobeats');
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); }); // past the debounce only
    expect(container!.textContent).toContain('Loading events…');

    await act(async () => { resolveCall(2); await Promise.resolve(); await Promise.resolve(); });
    expect(container!.textContent).toContain('Afrobeats Night');
  });

  it('shows an error state if the search query fails, without crashing or showing stale rows forever', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce();
    forcedError = 'Search request failed.';
    typeSearch('Afrobeats');
    await flushDebounce();
    expect(container!.textContent).toContain('Search request failed.');
  });

  it('a newer search supersedes a slower, still-pending earlier one (stale-response guard)', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flushDebounce(); // call #1 (initial load) resolves automatically

    manualMode = true;

    // "Jazz" is typed and its debounce fires, starting call #2 -- but it
    // does NOT resolve yet (manual mode).
    typeSearch('Jazz');
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expect(container!.textContent).toContain('Loading events…');

    // Before "Jazz" resolves, "Afrobeats" is typed; its own debounce fires,
    // starting call #3, which resolves immediately.
    typeSearch('Afrobeats');
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    await act(async () => { resolveCall(3); await Promise.resolve(); await Promise.resolve(); });

    expect(container!.textContent).toContain('Afrobeats Night');
    expect(container!.textContent).not.toContain('Jazz Evening');

    // Now let the slow "Jazz" response (call #2) land, well after -- it
    // must be dropped as stale, not overwrite the already-applied
    // "Afrobeats" result or flip loading back on.
    await act(async () => { resolveCall(2); await Promise.resolve(); await Promise.resolve(); });
    expect(container!.textContent).toContain('Afrobeats Night');
    expect(container!.textContent).not.toContain('Jazz Evening');
    expect(container!.textContent).not.toContain('Loading events…');
  });
});
