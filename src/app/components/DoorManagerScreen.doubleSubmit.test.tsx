import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { DoorManagerScreen } from './DoorManagerScreen';
import type { Event } from './types';
import type { Attendee } from '../../lib/useDoorManager';

// Regression tests for the large-event scalability audit finding #6: a
// rapid double-tap on "Confirm Entry" invoked doManualCheckIn a second
// time before React's `acting` state (which only updates on the next
// render) could disable the button, firing two manual_check_in RPC calls
// for the same ticket. Fixed with the same synchronous-ref re-entrancy
// guard already used elsewhere in this codebase (payingRef, bookingRef).
// The RPC itself is already atomic/idempotent (verified in the backend
// check-in audit) so this was never a double-check-in correctness bug --
// it's wasted network calls and inconsistency with the established
// double-submit-guard pattern.

const manualCheckInMock = vi.fn();
const ATTENDEE: Attendee = {
  ticket_id: 'ticket-1',
  holder_name: 'Jane Doe',
  holder_email: 'jane@example.com',
  buyer_phone: null,
  ticket_type: 'Regular',
  status: 'active',
  payment_status: 'paid',
  amount: 5000,
  checked_in: false,
  checked_in_at: null,
  is_manual_override: false,
  gate_name: null,
  purchased_at: '2026-01-01T00:00:00Z',
  order_ref: 'order-1',
  user_id: 'user-1',
  buyer_name: 'Jane Doe',
  avatar_url: null,
  scanner_name: null,
  device_id: null,
};

function mockUseDoorManager(overrides: Partial<ReturnType<typeof baseDm>> = {}) {
  return { ...baseDm(), ...overrides };
}
function baseDm() {
  return {
    stats: { total: 1, checked_in: 0, remaining: 1, attendance_pct: 0, duplicate_attempts: 0, invalid_attempts: 0 },
    feed: [],
    attendees: [ATTENDEE],
    search: '', setSearch: vi.fn(),
    filter: 'all' as const, setFilter: vi.fn(),
    gateName: '', setGateName: vi.fn(),
    loadingList: false, loadingMore: false, hasMore: false, live: true,
    loadMore: vi.fn(), refresh: vi.fn(),
    manualCheckIn: (...args: any[]) => manualCheckInMock(...args),
    scanLog: [], scanLogFilter: 'all' as const, setScanLogFilter: vi.fn(),
    loadingScanLog: false, loadingMoreScanLog: false, hasMoreScanLog: false, loadMoreScanLog: vi.fn(),
  };
}

vi.mock('../../lib/useDoorManager', () => ({
  useDoorManager: () => mockUseDoorManager(),
}));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: vi.fn() }));

// jsdom has no IntersectionObserver -- DoorManagerScreen's infinite-scroll
// sentinel effect needs a stub to mount at all in this test environment.
(globalThis as any).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const EVENT: Event = {
  id: 'event-1', title: 'Test Event', category: 'Music', categoryIcon: '🎵',
  date: '2099-01-01', time: '20:00', endTime: '23:00', venue: 'Venue', area: 'Area',
  city: 'Lagos', state: 'Lagos', country: 'NG', price: 5000, image: '',
  description: '', organizer: 'Org', isFeatured: false, isTrending: false,
  attendees: 0, capacity: 100, rating: 0, reviewCount: 0, ticketTypes: [],
  organizer_id: 'organizer-1',
};

const CURRENT_USER = { id: 'organizer-1', role: 'organizer' };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  manualCheckInMock.mockReset();
});

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <DoorManagerScreen event={EVENT} currentUser={CURRENT_USER} onBack={() => {}} onOpenScanner={() => {}} />
    );
    await Promise.resolve();
  });
}

async function openConfirmEntry() {
  // AttendeeRow itself is a <button> -- find it by its holder-name text,
  // distinct from any Live Activity feed entry (plain text, not a button)
  // that a prior successful check-in may have added.
  const rowButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Jane Doe'))!;
  act(() => { rowButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  const manualBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Manual Check-In'));
  act(() => { manualBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  return Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm Entry')!;
}

describe('DoorManagerScreen: manual check-in re-entrancy guard', () => {
  it('a rapid double-tap on Confirm Entry only calls manualCheckIn once', async () => {
    await renderScreen();
    const confirmBtn = await openConfirmEntry();

    let resolveCheckIn: (v: any) => void = () => {};
    manualCheckInMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCheckIn = resolve; }));

    act(() => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(manualCheckInMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCheckIn({ ok: true, holder_name: 'Jane Doe', checked_in_at: '2026-01-01T00:00:00Z' });
      await Promise.resolve();
    });
  });

  it('the guard resets after success so a later legitimate check-in works', async () => {
    await renderScreen();
    let confirmBtn = await openConfirmEntry();

    manualCheckInMock.mockResolvedValueOnce({ ok: true, holder_name: 'Jane Doe', checked_in_at: '2026-01-01T00:00:00Z' });
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(manualCheckInMock).toHaveBeenCalledTimes(1);

    // Re-open the sheet for a second attendee and confirm entry again --
    // the ref-based guard must not be permanently stuck true.
    confirmBtn = await openConfirmEntry();
    manualCheckInMock.mockResolvedValueOnce({ ok: true, holder_name: 'Jane Doe', checked_in_at: '2026-01-01T00:01:00Z' });
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(manualCheckInMock).toHaveBeenCalledTimes(2);
  });

  it('the guard resets after a rejected/failed check-in so retrying works', async () => {
    await renderScreen();
    let confirmBtn = await openConfirmEntry();

    manualCheckInMock.mockResolvedValueOnce({ ok: false, reason: 'already_scanned', message: 'Already checked in' });
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(manualCheckInMock).toHaveBeenCalledTimes(1);

    confirmBtn = await openConfirmEntry();
    manualCheckInMock.mockResolvedValueOnce({ ok: true, holder_name: 'Jane Doe', checked_in_at: '2026-01-01T00:02:00Z' });
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(manualCheckInMock).toHaveBeenCalledTimes(2);
  });
});
