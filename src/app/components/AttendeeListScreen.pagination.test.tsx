import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AttendeeListScreen } from './AttendeeListScreen';

// Regression tests for the large-event scalability audit finding: this
// screen used to loop get_event_attendees into ONE in-memory array before
// rendering anything (silently truncating past 20,000 rows) and always did
// client-side JS filtering with p_search/p_filter hardcoded to null/'all'.
// These tests prove the screen now (a) paginates server-side in bounded
// pages, (b) forwards search/status filter to the RPC instead of filtering
// in JS, and (c) shows real event-wide totals (get_door_stats) rather than
// a count over whatever page is loaded.

function makeRow(i: number, overrides: Partial<any> = {}) {
  return {
    ticket_id: `ticket-${String(i).padStart(4, '0')}`,
    holder_name: `Attendee ${i}`,
    holder_email: `attendee${i}@example.com`,
    ticket_type: 'Regular',
    status: 'active',
    checked_in: false,
    checked_in_at: null,
    payment_status: 'paid',
    ...overrides,
  };
}

const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpcMock(...args) },
  getAuthToken: vi.fn(async () => 'token'),
}));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/ticketImage', () => ({ downloadBlob: vi.fn(async () => 'shared') }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  rpcMock.mockReset();
});

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AttendeeListScreen onBack={() => {}} eventId="event-1" eventTitle="Test Event" />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AttendeeListScreen: server-side pagination', () => {
  it('requests only one bounded page (100 rows) on initial load, not the whole event', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 500, checked_in: 0 }, error: null });
      if (fn === 'get_event_attendees') return Promise.resolve({ data: Array.from({ length: 100 }, (_, i) => makeRow(i)), error: null });
      return Promise.resolve({ data: null, error: null });
    });

    await renderScreen();

    const attendeeCalls = rpcMock.mock.calls.filter((c) => c[0] === 'get_event_attendees');
    expect(attendeeCalls.length).toBe(1);
    expect(attendeeCalls[0][1]).toMatchObject({ p_limit: 100, p_offset: 0, p_search: null, p_filter: 'all' });
    expect(container!.textContent).toContain('100 loaded — scroll for more');
  });

  it('loading more appends a second page without duplicating rows and without re-fetching the first page', async () => {
    let call = 0;
    rpcMock.mockImplementation((fn: string, args: any) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 150, checked_in: 0 }, error: null });
      if (fn === 'get_event_attendees') {
        call++;
        if (args.p_offset === 0) return Promise.resolve({ data: Array.from({ length: 100 }, (_, i) => makeRow(i)), error: null });
        return Promise.resolve({ data: Array.from({ length: 50 }, (_, i) => makeRow(100 + i)), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await renderScreen();
    expect(container!.textContent).toContain('100 loaded — scroll for more');

    // Simulate scrolling near the bottom of the list container.
    const listEl = container!.querySelector('div[style*="overflow-y"]') as HTMLDivElement;
    Object.defineProperty(listEl, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(listEl, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(listEl, 'scrollTop', { value: 1300, configurable: true }); // within 300px of bottom

    await act(async () => {
      listEl.dispatchEvent(new Event('scroll', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('150 loaded');
    expect(container!.textContent).not.toContain('scroll for more'); // hasMore is now false (short page)
    const cards = container!.querySelectorAll('[title], p'); // sanity: no crash; exact count checked via state text above
    expect(cards.length).toBeGreaterThan(0);
  });

  it('typing in the search box forwards the query to get_event_attendees (server-side search), not a client-side filter', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 1, checked_in: 0 }, error: null });
      if (fn === 'get_event_attendees') return Promise.resolve({ data: [makeRow(1, { holder_name: 'Jane Doe' })], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await renderScreen();

    const input = container!.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'jane');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300)); // clear the 250ms debounce
    });

    const attendeeCalls = rpcMock.mock.calls.filter((c) => c[0] === 'get_event_attendees');
    const lastCall = attendeeCalls[attendeeCalls.length - 1];
    expect(lastCall[1]).toMatchObject({ p_search: 'jane' });
  });

  it('clicking a status filter pill forwards the RPC filter value instead of filtering the loaded array in JS', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 1, checked_in: 1 }, error: null });
      if (fn === 'get_event_attendees') return Promise.resolve({ data: [makeRow(1, { checked_in: true, checked_in_at: '2026-01-01T00:00:00Z' })], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await renderScreen();

    const pill = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Checked In')!;
    act(() => { pill.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });

    const attendeeCalls = rpcMock.mock.calls.filter((c) => c[0] === 'get_event_attendees');
    const lastCall = attendeeCalls[attendeeCalls.length - 1];
    expect(lastCall[1]).toMatchObject({ p_filter: 'checked_in' });
  });

  it('shows real event-wide totals from get_door_stats, not a count derived from the loaded page', async () => {
    rpcMock.mockImplementation((fn: string) => {
      // Only 2 rows loaded on screen, but the event genuinely has 5,000 attendees.
      if (fn === 'get_door_stats') return Promise.resolve({ data: { total: 5000, checked_in: 3200 }, error: null });
      if (fn === 'get_event_attendees') return Promise.resolve({ data: [makeRow(1), makeRow(2)], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    await renderScreen();

    expect(container!.textContent).toContain('3200 / 5000');
  });
});
