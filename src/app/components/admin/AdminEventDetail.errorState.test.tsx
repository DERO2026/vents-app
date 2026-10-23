import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminEventDetail } from './AdminEventDetail';

// Regression coverage for a confirmed bug: the analytics effect guarded
// on `analytics`/`analyticsLoading` themselves instead of a dedicated
// fetched-once flag. On a failed get_event_analytics call, `analytics`
// stays null forever and `analyticsLoading` cycles true->false -- since
// that flip is itself a listed dependency, the effect re-ran every time
// it flipped back to false, forever: an infinite re-fetch loop on any
// RPC failure, not just a cosmetic one. rpcCalls.length proves it only
// ran once.
//
// (The Audit tab's own swallowed-error bug -- .catch(() => setAudit([]))
// -- was fixed independently on main in a separate commit, with a more
// complete implementation: a distinct error message with a Retry button
// and a request-ID race guard. That fix, and its own thorough test
// coverage including retry and stale-response races, lives in
// AdminEventDetail.auditQuery.test.tsx; no need to duplicate it here.)

const eventData = {
  id: 'e1', title: 'Afrobeats Night', organizer_id: 'o1', hidden_by_admin: false, hidden_at: null,
  created_at: '2026-01-01T00:00:00Z', event_date: '2026-02-01T00:00:00Z', deleted_at: null,
  is_featured: false, featured_until: null, image_url: null,
  'users!events_organizer_id_fkey': { username: 'promoterco', full_name: 'Promoter Co', is_verified: true },
};

let rpcCalls = 0;
const admin = { id: 'admin-1', role: 'admin' };

vi.mock('../../../lib/supabase', () => {
  function makeEventsQuery() {
    const q: any = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: eventData, error: null }) };
    return q;
  }
  function makeFailingLogsQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      then: (resolve: any) => resolve({ data: null, error: { message: 'permission denied' } }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'events') return makeEventsQuery();
        return makeFailingLogsQuery();
      },
      rpc: (name: string) => {
        if (name === 'get_event_analytics') {
          rpcCalls++;
          return Promise.resolve({ data: null, error: { message: 'analytics unavailable' } });
        }
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rpcCalls = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); await Promise.resolve(); await Promise.resolve(); });
}

describe('AdminEventDetail: tab error states', () => {
  it('does not infinitely re-fetch analytics after a failed RPC call', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    await flush();

    expect(rpcCalls).toBe(1);
    const el = container.querySelector('[data-testid="admin-event-detail"]');
    expect(el?.textContent).toContain('analytics unavailable');
  });
});
