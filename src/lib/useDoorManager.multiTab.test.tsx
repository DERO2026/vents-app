import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { useDoorManager } from './useDoorManager';

// Regression tests for the large-event scalability audit finding #9:
// multiple staff dashboards open as separate browser tabs for the same
// event each independently ran get_door_stats/get_recent_checkins on
// every realtime check-in broadcast -- N open tabs meant N x the RPC load
// per burst, even though every tab watching the same event gets the exact
// same, unfiltered stats/feed answer. Fixed with a localStorage-mutex +
// BroadcastChannel hand-off so only one tab per browser actually fetches;
// its siblings apply the broadcast result directly. loadList/loadScanLog
// are deliberately left per-tab (they depend on each tab's own search/
// filter state, which genuinely can differ between tabs).

// jsdom has no BroadcastChannel -- this in-process polyfill mirrors real
// same-origin, same-browser BroadcastChannel semantics closely enough to
// exercise the coordination logic: instances sharing a `name` see each
// other's postMessage calls (but not their own).
class FakeBroadcastChannel {
  static registry: Record<string, FakeBroadcastChannel[]> = {};
  name: string;
  onmessage: ((e: { data: any }) => void) | null = null;
  constructor(name: string) {
    this.name = name;
    (FakeBroadcastChannel.registry[name] ||= []).push(this);
  }
  postMessage(data: any) {
    for (const ch of FakeBroadcastChannel.registry[this.name] || []) {
      if (ch !== this) ch.onmessage?.({ data });
    }
  }
  close() {
    FakeBroadcastChannel.registry[this.name] = (FakeBroadcastChannel.registry[this.name] || []).filter((c) => c !== this);
  }
}
(globalThis as any).BroadcastChannel = FakeBroadcastChannel;

// Mirrors the real supabase.channel(...).on('broadcast', {event}, cb) fan-
// out: every subscribed tab registers into the SAME handler registry
// (approximating the one real server-side topic all tabs share), so
// firing a handler here simulates the realtime event reaching every tab
// roughly simultaneously, same as production.
let broadcastHandlers: Record<string, Array<() => void>> = {};
function fireBroadcast(event: string) {
  (broadcastHandlers[event] || []).forEach((cb) => cb());
}

const rpcMock = vi.fn();
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => rpcMock(...args),
    channel: () => {
      const chain: any = {
        on: (_kind: string, cfg: { event: string }, cb: () => void) => {
          (broadcastHandlers[cfg.event] ||= []).push(cb);
          return chain;
        },
        subscribe: (cb?: (status: string) => void) => { cb?.('SUBSCRIBED'); return chain; },
      };
      return chain;
    },
    removeChannel: vi.fn(),
  },
}));

const STATS_V1 = { total: 10, checked_in: 3, remaining: 7, attendance_pct: 30, duplicate_attempts: 0, invalid_attempts: 0 };
const STATS_V2 = { total: 10, checked_in: 4, remaining: 6, attendance_pct: 40, duplicate_attempts: 0, invalid_attempts: 0 };

function mockRpcDefaults(stats: typeof STATS_V1) {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'get_door_stats') return Promise.resolve({ data: stats, error: null });
    if (fn === 'get_recent_checkins') return Promise.resolve({ data: [], error: null });
    if (fn === 'get_event_attendees') return Promise.resolve({ data: [], error: null });
    if (fn === 'get_scan_log') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

function Harness({ eventId, label }: { eventId: string; label: string }) {
  const dm = useDoorManager(eventId, 'actor-1');
  return <div data-testid={`stats-${label}`}>{dm.stats.checked_in}</div>;
}

let containers: HTMLDivElement[] = [];
let roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  broadcastHandlers = {};
  FakeBroadcastChannel.registry = {};
  localStorage.clear();
});

afterEach(() => {
  roots.forEach((r) => act(() => r.unmount()));
  containers.forEach((c) => c.remove());
  containers = [];
  roots = [];
  rpcMock.mockReset();
  vi.useRealTimers();
});

async function mountTab(eventId: string, label: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<Harness eventId={eventId} label={label} />);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(260); }); // clear initial-load debounces
  return container;
}

function statsCallCount() {
  return rpcMock.mock.calls.filter((c) => c[0] === 'get_door_stats').length;
}

describe('useDoorManager: cross-tab stats/feed coordination', () => {
  it('two tabs open for the same event: a broadcast burst triggers only ONE get_door_stats/get_recent_checkins call, and both tabs still update', async () => {
    mockRpcDefaults(STATS_V1);
    const tabA = await mountTab('event-1', 'a');
    const tabB = await mountTab('event-1', 'b');

    expect(tabA.querySelector('[data-testid="stats-a"]')!.textContent).toBe('3');
    expect(tabB.querySelector('[data-testid="stats-b"]')!.textContent).toBe('3');

    mockRpcDefaults(STATS_V2);
    rpcMock.mockClear();

    await act(async () => {
      fireBroadcast('checkin');
      await vi.advanceTimersByTimeAsync(310); // clear the 300ms bump debounce
    });

    expect(statsCallCount()).toBe(1); // NOT 2 -- only one tab actually fetched
    expect(tabA.querySelector('[data-testid="stats-a"]')!.textContent).toBe('4');
    expect(tabB.querySelector('[data-testid="stats-b"]')!.textContent).toBe('4'); // received via BroadcastChannel, not its own fetch
  });

  it('a single open tab (no siblings) still fetches and updates exactly as before', async () => {
    mockRpcDefaults(STATS_V1);
    const tab = await mountTab('event-1', 'solo');
    expect(tab.querySelector('[data-testid="stats-solo"]')!.textContent).toBe('3');

    mockRpcDefaults(STATS_V2);
    rpcMock.mockClear();

    await act(async () => {
      fireBroadcast('checkin');
      await vi.advanceTimersByTimeAsync(310);
    });

    expect(statsCallCount()).toBe(1);
    expect(tab.querySelector('[data-testid="stats-solo"]')!.textContent).toBe('4');
  });

  it('guest list and scan log are NOT coordinated -- both tabs still refetch their own (filter-dependent) copy on a broadcast', async () => {
    mockRpcDefaults(STATS_V1);
    await mountTab('event-1', 'a');
    await mountTab('event-1', 'b');
    rpcMock.mockClear();

    await act(async () => {
      fireBroadcast('ticket');
      await vi.advanceTimersByTimeAsync(310);
    });

    const attendeeCalls = rpcMock.mock.calls.filter((c) => c[0] === 'get_event_attendees').length;
    const scanLogCalls = rpcMock.mock.calls.filter((c) => c[0] === 'get_scan_log').length;
    expect(attendeeCalls).toBe(2); // one per tab, unaffected by the stats coordination
    expect(scanLogCalls).toBe(2);
  });

  it('falls back to independent per-tab fetching when localStorage is unavailable, without crashing', async () => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('storage disabled'); };
    Storage.prototype.setItem = () => { throw new Error('storage disabled'); };
    try {
      mockRpcDefaults(STATS_V1);
      const tabA = await mountTab('event-1', 'a');
      const tabB = await mountTab('event-1', 'b');

      mockRpcDefaults(STATS_V2);
      rpcMock.mockClear();

      await act(async () => {
        fireBroadcast('checkin');
        await vi.advanceTimersByTimeAsync(310);
      });

      // Without a working lock, both tabs fall back to fetching for
      // themselves -- no crash, no stuck/stale state.
      expect(statsCallCount()).toBeGreaterThanOrEqual(1);
      expect(tabA.querySelector('[data-testid="stats-a"]')!.textContent).toBe('4');
      expect(tabB.querySelector('[data-testid="stats-b"]')!.textContent).toBe('4');
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  });

  it('tabs watching DIFFERENT events do not suppress each other\'s stats fetch', async () => {
    mockRpcDefaults(STATS_V1);
    const tabA = await mountTab('event-1', 'a');
    const tabB = await mountTab('event-2', 'b');
    rpcMock.mockClear();

    await act(async () => {
      fireBroadcast('checkin'); // both tabs share the mocked broadcast registry in this test setup
      await vi.advanceTimersByTimeAsync(310);
    });

    // Different eventIds -> different lock keys and different
    // BroadcastChannel names -- both must fetch independently.
    expect(statsCallCount()).toBe(2);
    expect(tabA.querySelector('[data-testid="stats-a"]')).toBeTruthy();
    expect(tabB.querySelector('[data-testid="stats-b"]')).toBeTruthy();
  });
});
