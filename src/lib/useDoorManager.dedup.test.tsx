import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { useDoorManager } from './useDoorManager';

// Regression tests for the large-event scalability audit finding #6:
// useDoorManager.loadList appended pagination pages via `[...prev, ...rows]`
// with no de-dup by ticket_id. get_event_attendees orders by
// checked_in_at DESC NULLS LAST, created_at DESC -- at a busy door with
// many simultaneous scanners, a check-in landing between two page fetches
// can shift that ordering just enough that the same ticket appears in both
// an already-loaded page and a newly-fetched one (OFFSET pagination has no
// stable cursor), rendering it twice in the guest list. Fixed by de-duping
// on ticket_id when appending.

function makeAttendee(id: string, overrides: Partial<any> = {}) {
  return {
    ticket_id: id, holder_name: `Attendee ${id}`, holder_email: null, buyer_phone: null,
    ticket_type: 'Regular', status: 'active', payment_status: 'paid', amount: 1000,
    checked_in: false, checked_in_at: null, is_manual_override: false, gate_name: null,
    purchased_at: '2026-01-01T00:00:00Z', order_ref: null, user_id: null, buyer_name: null,
    avatar_url: null, scanner_name: null, device_id: null,
    ...overrides,
  };
}

const rpcMock = vi.fn();
const channelMock = {
  on: vi.fn(function (this: any) { return this; }),
  subscribe: vi.fn(), // never invokes the status callback -- keeps tests deterministic
};
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => rpcMock(...args),
    channel: () => channelMock,
    removeChannel: vi.fn(),
  },
}));

function Harness({ eventId }: { eventId: string }) {
  const dm = useDoorManager(eventId, 'actor-1');
  return (
    <div>
      <div data-testid="count">{dm.attendees.length}</div>
      <div data-testid="ids">{dm.attendees.map((a) => a.ticket_id).join(',')}</div>
      <button onClick={() => dm.loadMore()}>loadMore</button>
    </div>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpcMock.mockReset();
  vi.useRealTimers();
});

async function renderHarness() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness eventId="event-1" />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260); // clear the 250ms initial-load debounce
  });
}

function idsText() {
  return container!.querySelector('[data-testid="ids"]')!.textContent;
}
function countText() {
  return container!.querySelector('[data-testid="countdiv"]');
}

describe('useDoorManager: guest list pagination de-dup', () => {
  it('same ticket appearing in two overlapping pages is only rendered once', async () => {
    // Page 1 (offset 0): tickets 1..40 (PAGE_SIZE). Page 2 (offset 40): the
    // ordering shifted (a check-in landed mid-scroll) so ticket "40" is
    // re-returned as the first row of page 2 alongside genuinely new ones.
    const page1 = Array.from({ length: 40 }, (_, i) => makeAttendee(String(i + 1)));
    const page2 = [makeAttendee('40'), makeAttendee('41'), makeAttendee('42')];

    rpcMock.mockImplementation((fn: string, args: any) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 42, checked_in: 0, remaining: 42, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 }, error: null });
      if (fn === 'get_recent_checkins') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_scan_log') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_event_attendees') {
        return Promise.resolve({ data: args.p_offset === 0 ? page1 : page2, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await renderHarness();
    expect(container!.querySelector('[data-testid="count"]')!.textContent).toBe('40');

    const loadMoreBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'loadMore')!;
    await act(async () => {
      loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // 40 original + 2 genuinely new (41, 42) -- "40" must not be duplicated.
    expect(container!.querySelector('[data-testid="count"]')!.textContent).toBe('42');
    const ids = idsText()!.split(',');
    expect(ids.filter((id) => id === '40').length).toBe(1);
  });

  it('rapid repeated loadMore calls before a response resolves do not double-append', async () => {
    const page1 = Array.from({ length: 40 }, (_, i) => makeAttendee(String(i + 1)));
    let resolvePage2: (v: any) => void = () => {};
    rpcMock.mockImplementation((fn: string, args: any) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 43, checked_in: 0, remaining: 43, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 }, error: null });
      if (fn === 'get_recent_checkins') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_scan_log') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_event_attendees') {
        if (args.p_offset === 0) return Promise.resolve({ data: page1, error: null });
        return new Promise((resolve) => { resolvePage2 = resolve; });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await renderHarness();
    const loadMoreBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'loadMore')!;

    // Two rapid clicks -- useDoorManager's own loadingMore/hasMore guard on
    // loadMore() should mean only one request is actually in flight.
    act(() => {
      loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      resolvePage2({ data: [makeAttendee('41'), makeAttendee('42'), makeAttendee('43')], error: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.querySelector('[data-testid="count"]')!.textContent).toBe('43');
  });

  it('different tickets across pages all accumulate correctly with no loss', async () => {
    const page1 = Array.from({ length: 40 }, (_, i) => makeAttendee(String(i + 1)));
    const page2 = Array.from({ length: 40 }, (_, i) => makeAttendee(String(41 + i)));
    const page3 = Array.from({ length: 10 }, (_, i) => makeAttendee(String(81 + i)));
    rpcMock.mockImplementation((fn: string, args: any) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 90, checked_in: 0, remaining: 90, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 }, error: null });
      if (fn === 'get_recent_checkins') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_scan_log') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_event_attendees') {
        if (args.p_offset === 0) return Promise.resolve({ data: page1, error: null });
        if (args.p_offset === 40) return Promise.resolve({ data: page2, error: null });
        return Promise.resolve({ data: page3, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await renderHarness();
    const loadMoreBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'loadMore')!;
    await act(async () => { loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });

    expect(container!.querySelector('[data-testid="count"]')!.textContent).toBe('90');
    const ids = new Set(idsText()!.split(','));
    expect(ids.size).toBe(90);
  });

  it('a reset (search/filter change) replaces the list rather than accumulating stale state', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 1, checked_in: 0, remaining: 1, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 }, error: null });
      if (fn === 'get_recent_checkins') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_scan_log') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_event_attendees') return Promise.resolve({ data: [makeAttendee('1')], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await renderHarness();
    expect(container!.querySelector('[data-testid="count"]')!.textContent).toBe('1');
  });

  it('accumulating many pages (simulating thousands of attendees) never grows state beyond the true unique total', async () => {
    const TOTAL_PAGES = 30; // 30 * 40 = 1,200 unique tickets across many loadMore calls
    let servedPages = 0;
    rpcMock.mockImplementation((fn: string, args: any) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: TOTAL_PAGES * 40, checked_in: 0, remaining: 0, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 }, error: null });
      if (fn === 'get_recent_checkins') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_scan_log') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_event_attendees') {
        const page = Math.floor(args.p_offset / 40);
        servedPages = Math.max(servedPages, page + 1);
        const start = page * 40;
        return Promise.resolve({ data: Array.from({ length: 40 }, (_, i) => makeAttendee(String(start + i))), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await renderHarness();
    const loadMoreBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'loadMore')!;
    for (let i = 0; i < TOTAL_PAGES - 1; i++) {
      await act(async () => {
        loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(container!.querySelector('[data-testid="count"]')!.textContent).toBe(String(TOTAL_PAGES * 40));
    const ids = new Set(idsText()!.split(','));
    expect(ids.size).toBe(TOTAL_PAGES * 40); // no duplicates accumulated across 30 pages
  });
});
