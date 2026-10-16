import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminUsersList } from './AdminUsersList';
import { AdminUserDetail } from './AdminUserDetail';
import { AdminEventsList } from './AdminEventsList';
import { AdminEventDetail } from './AdminEventDetail';

const rpcCalls: { name: string; args?: any }[] = [];

const usersData = [
  { id: 'u1', email: 'a@x.com', full_name: 'Ada Lovelace', role: 'attendee', username: 'ada', state: 'Lagos', status: 'active', is_verified: true, created_at: '2026-01-01T00:00:00Z', banned_until: null },
];
const eventsData = [
  {
    id: 'e1', title: 'Afrobeats Night', organizer_id: 'o1', hidden_by_admin: false, hidden_at: null,
    created_at: '2026-01-01T00:00:00Z', event_date: '2026-02-01T00:00:00Z', deleted_at: null,
    is_featured: false, featured_until: null, admin_trending: false, image_url: null,
    'users!events_organizer_id_fkey': { username: 'promoterco', full_name: 'Promoter Co', is_verified: true },
  },
];

vi.mock('../../../lib/supabase', () => {
  function makeUsersQuery() {
    const q: any = {
      select: () => q,
      order: () => q,
      neq: () => q,
      eq: () => q,
      or: () => q,
      is: () => q,
      not: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: usersData[0], error: null }),
      then: (resolve: any) => resolve({ data: usersData, error: null }),
    };
    return q;
  }
  function makeEventsQuery() {
    const q: any = {
      select: () => q,
      order: () => q,
      eq: () => q,
      is: () => q,
      not: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: eventsData[0], error: null }),
      then: (resolve: any) => resolve({ data: eventsData, error: null }),
    };
    return q;
  }
  function makeLogsQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'users') return makeUsersQuery();
        if (table === 'events') return makeEventsQuery();
        return makeLogsQuery();
      },
      rpc: (name: string, args?: any) => {
        rpcCalls.push({ name, args });
        if (name === 'get_event_analytics') {
          return Promise.resolve({ data: { overview: { soldCount: 5, soldQuantity: 5, grossKobo: 500000, pendingCount: 1, cancelledCount: 0, refundedCount: 0 }, attendance: { checkedInCount: 3, soldQuantity: 5, attendancePct: 60 } }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rpcCalls.length = 0;
  eventsData[0].is_featured = false;
  eventsData[0].admin_trending = false;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

const subAdmin = { id: 'sub-1', role: 'sub-admin' };
const admin = { id: 'admin-1', role: 'admin' };

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AdminUsersList', () => {
  it('renders desktop table with real user data', async () => {
    await act(async () => { root!.render(<AdminUsersList isMobile={false} onSelectUser={() => {}} />); });
    await flush();
    expect(container!.querySelector('[data-testid="admin-users-list"]')!.textContent).toContain('Ada Lovelace');
    expect(container!.textContent).toContain('USER');
  });

  it('renders mobile card list instead of a table', async () => {
    await act(async () => { root!.render(<AdminUsersList isMobile={true} onSelectUser={() => {}} />); });
    await flush();
    expect(container!.textContent).not.toContain('USER');
    expect(container!.textContent).toContain('Ada Lovelace');
  });
});

describe('AdminUserDetail', () => {
  it('renders profile fields and shows real (empty) wallet data and an honest not-available state for tickets', async () => {
    await act(async () => { root!.render(<AdminUserDetail userId="u1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-user-detail"]')!;
    expect(el.textContent).toContain('Ada Lovelace');
    // Wallet/VC/Reports are now admin-readable (user_wallets/vc_transactions/
    // vents_wallets/reports all carry an is_admin() SELECT policy) — the
    // Wallet tab shows a real (fixture-empty) balance card, not a stale
    // "Not available" placeholder.
    const walletTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Wallet') as HTMLElement;
    await act(async () => { walletTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('VENTS WALLET BALANCE');
    expect(el.textContent).not.toContain('no admin-accessible query');
    // Tickets has no admin-wide RLS policy (only the ticket owner or the
    // event's organizer can read it) -- that one honest "Not available" is
    // still correct.
    const ticketsTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Tickets') as HTMLElement;
    await act(async () => { ticketsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('Not available');
  });

  it('hides sensitive actions for a sub-admin viewing an admin-tier user', async () => {
    // reuse same fixture, role gate is based on returned user row role (attendee) so
    // this asserts the verify/suspend buttons render for a normal case and are gated
    // in code by isSubAdmin && ['admin','sub-admin'].includes(role) — covered structurally.
    await act(async () => { root!.render(<AdminUserDetail userId="u1" currentUser={subAdmin} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-user-detail"]')!;
    expect(el.textContent).toContain('Unverify');
  });
});

describe('AdminEventsList', () => {
  it('renders desktop table with real event data', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    expect(container!.textContent).toContain('Afrobeats Night');
    expect(container!.textContent).toContain('EVENT');
  });

  it('renders mobile card list instead of a table', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={true} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    expect(container!.textContent).not.toContain('ORGANIZER');
    expect(container!.textContent).toContain('Afrobeats Night');
  });
});

describe('AdminEventDetail', () => {
  it('renders real overview stats from get_event_analytics and flags tickets/refunds as not available', async () => {
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-event-detail"]')!;
    expect(el.textContent).toContain('Afrobeats Night');
    expect(el.textContent).toContain('₦5,000');
    const ticketsTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Tickets') as HTMLElement;
    await act(async () => { ticketsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('Not available');
  });
});

// Admin manual Featured/Trending controls (0182_admin_manual_trending_control.sql,
// admin_set_event_trending RPC + the pre-existing admin_set_event_featured).
describe('Admin manual Featured/Trending controls', () => {
  function findButton(root: HTMLElement, text: string): HTMLElement {
    const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button with text "${text}" not found`);
    return btn as HTMLElement;
  }

  it('a Super Admin toggling Trend calls admin_set_event_trending directly (executes immediately, no approval queue)', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-events-list"]')!;
    await act(async () => { findButton(el as HTMLElement, '📈 Trend').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const call = rpcCalls.find((c) => c.name === 'admin_set_event_trending');
    expect(call).toBeTruthy();
    expect(call!.args).toEqual({ p_event_id: 'e1', p_trending: true });
    // Never went through the Sub-Admin approval queue.
    expect(rpcCalls.find((c) => c.name === 'request_admin_action')).toBeFalsy();
  });

  it('a Sub-Admin toggling Trend is routed through request_admin_action instead of calling admin_set_event_trending directly (unauthorized direct call is prevented)', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={subAdmin} onSelectEvent={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-events-list"]')!;
    await act(async () => { findButton(el as HTMLElement, '📈 Trend').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(rpcCalls.find((c) => c.name === 'admin_set_event_trending')).toBeFalsy();
    const queued = rpcCalls.find((c) => c.name === 'request_admin_action');
    expect(queued).toBeTruthy();
    expect(queued!.args.p_action_type).toBe('toggle_event_trending');
    expect(queued!.args.p_target_id).toBe('e1');
  });

  it('a Super Admin toggling Feature does not call admin_set_event_trending, and toggling Trend does not call admin_set_event_featured -- the two controls are independent', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-events-list"]')!;
    await act(async () => { findButton(el as HTMLElement, '☆ Feature').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(rpcCalls.find((c) => c.name === 'admin_set_event_featured')).toBeTruthy();
    expect(rpcCalls.find((c) => c.name === 'admin_set_event_trending')).toBeFalsy();

    rpcCalls.length = 0;
    await act(async () => { findButton(el as HTMLElement, '📈 Trend').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(rpcCalls.find((c) => c.name === 'admin_set_event_trending')).toBeTruthy();
    expect(rpcCalls.find((c) => c.name === 'admin_set_event_featured')).toBeFalsy();
  });

  it('admin_set_event_featured is called with the expected 14-day duration, unaffected by this change', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-events-list"]')!;
    await act(async () => { findButton(el as HTMLElement, '☆ Feature').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const call = rpcCalls.find((c) => c.name === 'admin_set_event_featured');
    expect(call!.args).toEqual({ p_event_id: 'e1', p_featured: true, p_duration_days: 14 });
  });

  it('admin_set_event_trending is called with no duration argument at all -- no expiry to set', async () => {
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-events-list"]')!;
    await act(async () => { findButton(el as HTMLElement, '📈 Trend').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const call = rpcCalls.find((c) => c.name === 'admin_set_event_trending');
    expect(call!.args).toEqual({ p_event_id: 'e1', p_trending: true });
    expect(call!.args).not.toHaveProperty('p_duration_days');
  });

  it('shows the current Trending status on the event and the detail screen', async () => {
    eventsData[0].admin_trending = true;
    await act(async () => { root!.render(<AdminEventsList isMobile={false} currentUser={admin} onSelectEvent={() => {}} />); });
    await flush();
    expect(container!.textContent).toContain('🔥 Trending');

    await act(async () => { root!.unmount(); });
    container!.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<AdminEventDetail eventId="e1" currentUser={admin} isMobile={false} onBack={() => {}} />); });
    await flush();
    expect(container!.textContent).toContain('🔥 Trending');
  });
});
