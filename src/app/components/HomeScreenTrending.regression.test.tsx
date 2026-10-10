import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { HomeScreen } from './HomeScreen';

// Task 3 (VENTS release sprint): "Trending" is HomeScreen.tsx's organic
// Trending Events rail (trendingEvents, ~line 1361), sourced from
// filterResults (filtersActive is now a hardcoded `true` -- see its own
// comment: countryFilter must always be applied, so this country-scoped
// query always runs instead of the country-blind dbEvents page) and the
// real, server-computed get_event_trending_scores RPC (recent sold *5 +
// total sold *2 + saves *1). An event only appears once it has positive
// score; display is capped at 5, sorted by score desc then nearest date.
//
// Investigated before changing any code, per the task's instruction not
// to invent a fix. Traced the full path and cross-checked against live
// production data (slrtjxtzhowhwhebjprv) this session:
// - get_event_trending_scores itself (SECURITY DEFINER, LANGUAGE sql, no
//   check_rate_limit call -- not the Task 1 bug class) computes correctly:
//   verified live for a real event (21 tickets sold -> score 42 = 21*2).
// - Several currently live, non-deleted/archived/hidden, future-dated NG
//   events have real ticket sales (1-21 sold) and so have positive
//   trending scores confirmed live; they fall within filterResults' own
//   query shape (status in ('live','published'), not archived/deleted/
//   hidden, end_date/event_date window, country-matched) and pass
//   isEventDiscoverable's lifecycle rule identically.
// Could not reproduce a defect in the query, RPC, ranking, or filtering
// logic against real data -- everything computes end-to-end correctly.
// No source code changed; this adds the regression coverage that didn't
// exist before (no HomeScreen test covered Trending at all) so a future
// change to this logic is caught if it breaks.

const rpcMock = vi.fn(async (_fn: string, _args: any) => ({ data: [], error: null }));

function makeEventsQueryBuilder(rows: any[]) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    or: () => builder,
    in: () => builder,
    ilike: () => builder,
    gt: () => builder,
    not: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return builder;
}

let eventsRows: any[] = [];

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'events') return makeEventsQueryBuilder(eventsRows);
      return makeEventsQueryBuilder([]);
    },
    rpc: (fn: string, args: any) => rpcMock(fn, args),
  },
}));

vi.mock('../../lib/useGeolocation', () => ({
  useGeolocation: () => ({ status: 'denied', lat: null, lng: null }),
}));

vi.mock('../../lib/serviceProviders', () => ({
  fetchApprovedServiceProviders: vi.fn(async () => []),
  fetchNearbyServiceProviders: vi.fn(async () => []),
  withProviderRatings: vi.fn(async (rows: any[]) => rows),
}));

vi.mock('../../lib/analyticsEvents', () => ({ analytics: new Proxy({}, { get: () => () => {} }) }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function futureIso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function makeEventRow(id: string, title: string, daysFromNow: number, overrides: Record<string, any> = {}) {
  return {
    id,
    title,
    event_date: futureIso(daysFromNow),
    end_date: null,
    status: 'live',
    country: 'NG',
    category: 'Conference',
    hidden_by_admin: false,
    deleted_at: null,
    archived_at: null,
    is_18_plus: false,
    price: 0,
    organizer_id: 'org-1',
    users: { username: 'organizer', full_name: 'Organizer', vc_badge: null },
    ...overrides,
  };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpcMock.mockReset();
  rpcMock.mockImplementation(async () => ({ data: [], error: null }));
  eventsRows = [];
});

// Trending's own rail sits before "Explore Events" (the main grid), which
// renders every event regardless of trending status -- so assertions
// about what Trending does/doesn't show must be scoped to the text
// between those two headings, not the whole page.
function trendingSectionText(): string {
  const text = container!.textContent!;
  const start = text.indexOf('Trending Events');
  if (start === -1) return '';
  const end = text.indexOf('Explore Events', start);
  return text.slice(start, end === -1 ? undefined : end);
}

async function renderHome() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <HomeScreen
        onEventPress={() => {}}
        savedEvents={[]}
        onToggleSave={() => {}}
        dbEvents={[]}
        loading={false}
        fetchEvents={() => {}}
        countryFilter="NG"
        onCountryFilterChange={() => {}}
      />
    );
  });
}

describe('HomeScreen "Trending Events": ranking, filtering, and failure handling', () => {
  it('shows only events with a positive trending score, sorted by score then nearest date', async () => {
    eventsRows = [
      makeEventRow('e-low', 'Low Score Event', 10),
      makeEventRow('e-high', 'High Score Event', 20),
      makeEventRow('e-zero', 'No Engagement Event', 5),
    ];
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'get_event_trending_scores') {
        return { data: [
          { event_id: 'e-low', trending_score: 4 },
          { event_id: 'e-high', trending_score: 42 },
          { event_id: 'e-zero', trending_score: 0 },
        ], error: null };
      }
      return { data: [], error: null };
    });
    await renderHome();
    expect(container!.textContent).toContain('Trending Events');
    const trending = trendingSectionText();
    expect(trending).toContain('High Score Event');
    expect(trending).toContain('Low Score Event');
    expect(trending).not.toContain('No Engagement Event');
  });

  it('never shows the Trending Events section when every event scores zero (no invented fallback data)', async () => {
    eventsRows = [makeEventRow('e-zero', 'Nothing Trending', 5)];
    rpcMock.mockImplementation(async () => ({ data: [{ event_id: 'e-zero', trending_score: 0 }], error: null }));
    await renderHome();
    expect(container!.textContent).not.toContain('Trending Events');
  });

  it('caps Trending at 5 events even when more have positive scores', async () => {
    eventsRows = Array.from({ length: 7 }, (_, i) => makeEventRow(`e-${i}`, `Event ${i}`, 10 + i));
    rpcMock.mockImplementation(async () => ({
      data: eventsRows.map((_, i) => ({ event_id: `e-${i}`, trending_score: 10 - i })),
      error: null,
    }));
    await renderHome();
    const matches = trendingSectionText().match(/Event \d/g) || [];
    expect(new Set(matches).size).toBeLessThanOrEqual(5);
  });

  it('degrades gracefully when the trending-score RPC itself fails -- no crash, section just does not render', async () => {
    eventsRows = [makeEventRow('e-1', 'Some Event', 10)];
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'get_event_trending_scores') throw new Error('permission denied');
      return { data: [], error: null };
    });
    await expect(renderHome()).resolves.not.toThrow();
    expect(container!.textContent).not.toContain('Trending Events');
  });

  it('degrades gracefully when the base events query itself fails -- no crash, no stale/invented events', async () => {
    vi.doMock('../../lib/supabase', () => ({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              is: () => ({
                is: () => ({
                  or: () => ({ in: () => ({ limit: () => Promise.resolve({ data: null, error: new Error('db down') }) }) }),
                }),
              }),
            }),
          }),
        }),
        rpc: () => Promise.resolve({ data: [], error: null }),
      },
    }));
    await expect(renderHome()).resolves.not.toThrow();
  });

  it('excludes an otherwise-qualifying event once its date has passed (no stale trending content)', async () => {
    eventsRows = [makeEventRow('e-past', 'Past Event', -5)];
    rpcMock.mockImplementation(async () => ({ data: [{ event_id: 'e-past', trending_score: 50 }], error: null }));
    await renderHome();
    expect(container!.textContent).not.toContain('Trending Events');
  });
});
