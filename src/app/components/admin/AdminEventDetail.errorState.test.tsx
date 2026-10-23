import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminEventDetail } from './AdminEventDetail';

// Regression coverage for two confirmed bugs:
//
// 1. The analytics effect guarded on `analytics`/`analyticsLoading`
//    themselves instead of a dedicated fetched-once flag. On a failed
//    get_event_analytics call, `analytics` stays null forever and
//    `analyticsLoading` cycles true->false -- since that flip is itself
//    a listed dependency, the effect re-ran every time it flipped back
//    to false, forever: an infinite re-fetch loop on any RPC failure,
//    not just a cosmetic one. rpcCalls.length proves it only ran once.
//
// 2. The audit effect's .catch(() => setAudit([])) swallowed a failed
//    fetch into the exact same empty array a genuinely clean audit
//    trail produces, so a query failure rendered as "No admin actions
//    recorded for this event."

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

  it('Audit tab shows an explicit error instead of "No admin actions recorded" when the fetch fails', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();

    const el = container.querySelector('[data-testid="admin-event-detail"]')!;
    const auditTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Audit') as HTMLElement;
    await act(async () => { auditTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(el.textContent).toContain('could not load the audit trail');
    expect(el.textContent).not.toContain('No admin actions recorded for this event.');
  });
});
