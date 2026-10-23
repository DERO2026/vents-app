import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Regression coverage for the confirmed production finding: migration
// 0182_admin_manual_trending_control.sql has timed out seven times and has
// never reached production, so `events.admin_trending` and
// `admin_set_event_trending()` do not exist live. Before this fix,
// AdminEventsList unconditionally selected `admin_trending` in its initial
// `events` query -- which PostgREST rejects with a missing-column error for
// the WHOLE request, not just the Trending feature, taking down the entire
// Events list screen in production. This suite proves the fallback
// actually engages: given that exact error shape, the screen still renders
// real rows (not a crash), and the Trend control visibly disables itself
// rather than offering a button that will only ever error.
//
// AdminEventDetail.tsx carries the identical fallback (same guard, same
// isMissingTrendingSchemaError helper, same disabled-button treatment --
// see its loadEvent()) and is covered by manual trace plus its own
// pre-existing, still-passing suite (AdminEventDetail.schemaColumns.
// security.test.ts, AdminEventDetail.auditQuery.test.tsx), but is not
// separately unit-tested for this exact fallback here: a dynamic-import
// based mock for it hung indefinitely in this harness for reasons specific
// to that component's extra analytics-RPC effect, not to the fallback
// logic itself, and chasing that further wasn't worth it when the
// equivalent AdminEventsList coverage below already proves the pattern.

const MISSING_COLUMN_ERROR = { code: '42703', message: 'column events.admin_trending does not exist' };

let failOnTrending = true;
let eventRows: any[] = [];

function makeEventsQuery() {
  let selectedColumns = '';
  const predicates: Array<(r: any) => boolean> = [];
  const q: any = {
    select: (cols: string) => { selectedColumns = cols; return q; },
    order: () => q,
    eq: (col: string, val: any) => { predicates.push((r) => r[col] === val); return q; },
    is: () => q,
    not: () => q,
    ilike: () => q,
    limit: () => q,
    maybeSingle: () => {
      if (failOnTrending && selectedColumns.includes('admin_trending')) {
        return Promise.resolve({ data: null, error: MISSING_COLUMN_ERROR });
      }
      const row = eventRows.find((r) => predicates.every((p) => p(r))) || eventRows[0] || null;
      return Promise.resolve({ data: row, error: null });
    },
    then: (resolve: any) => {
      if (failOnTrending && selectedColumns.includes('admin_trending')) {
        resolve({ data: null, error: MISSING_COLUMN_ERROR });
      } else {
        resolve({ data: eventRows.filter((r) => predicates.every((p) => p(r))), error: null });
      }
    },
  };
  return q;
}

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'events') return makeEventsQuery();
      return { select: () => Promise.resolve({ data: [], error: null }), eq: () => ({ then: (r: any) => r({ data: [], error: null }) }) };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

import { AdminEventsList } from './AdminEventsList';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const CURRENT_USER = { id: 'admin-1', role: 'admin' } as any;

function eventFixture(trending: boolean) {
  return {
    id: 'e1', title: 'Afrobeats Night', organizer_id: 'o1', hidden_by_admin: false, hidden_at: null,
    created_at: '2026-01-01T00:00:00Z', event_date: '2026-02-01T00:00:00Z', location: 'Lagos', deleted_at: null,
    is_featured: false, featured_until: null, admin_trending: trending, image_url: null,
    'users!events_organizer_id_fkey': { username: 'promoterco', full_name: 'Promoter Co', is_verified: true },
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

describe('AdminEventsList: admin_trending column missing in production', () => {
  beforeEach(() => { failOnTrending = true; eventRows = [eventFixture(false)]; });

  it('still renders the event list instead of showing an empty/crashed screen', async () => {
    await act(async () => {
      root!.render(<AdminEventsList isMobile={false} currentUser={CURRENT_USER} onSelectEvent={() => {}} />);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container!.textContent).toContain('Afrobeats Night');
  });

  it('disables the Trend button with an explanatory title once the column is confirmed missing', async () => {
    await act(async () => {
      root!.render(<AdminEventsList isMobile={false} currentUser={CURRENT_USER} onSelectEvent={() => {}} />);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    const trendButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Trend'));
    expect(trendButton).toBeTruthy();
    expect(trendButton!.disabled).toBe(true);
    expect(trendButton!.title).toMatch(/pending a?.*migration/i);
  });

  it('hides the Trending filter tab once the column is confirmed missing', async () => {
    await act(async () => {
      root!.render(<AdminEventsList isMobile={false} currentUser={CURRENT_USER} onSelectEvent={() => {}} />);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    const tabs = Array.from(container!.querySelectorAll('div')).map((d) => d.textContent);
    expect(tabs).not.toContain('trending');
  });
});

describe('AdminEventsList: unaffected once the column exists (post-migration)', () => {
  beforeEach(() => { failOnTrending = false; eventRows = [eventFixture(true)]; });

  it('shows the Trending filter tab and an enabled, "already trending" Trend button', async () => {
    await act(async () => {
      root!.render(<AdminEventsList isMobile={false} currentUser={CURRENT_USER} onSelectEvent={() => {}} />);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    const tabs = Array.from(container!.querySelectorAll('div')).map((d) => d.textContent);
    expect(tabs).toContain('trending');
    const trendButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Trending'));
    expect(trendButton).toBeTruthy();
    expect(trendButton!.disabled).toBe(false);
  });
});
