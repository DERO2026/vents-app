import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Event attendance visibility (0221): the other public surfaces -- the Home
// feed card's sales badge, the ticket picker's live availability, the
// DB-row mapping every feed/search/saved list uses -- and the shared helpers.

let availabilityRows: any[] = [];
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string) => Promise.resolve(fn === 'get_event_ticket_type_availability' ? { data: availabilityRows, error: null } : { data: null, error: null }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  },
}));

import { FeedCard, mapDbEventToFrontend } from './HomeScreen';
import { TicketSelectScreen } from './TicketSelectScreen';
import {
  canViewAttendanceCount, isMissingAttendanceColumnError, rowShowsAttendanceCount, DEFAULT_SHOW_ATTENDANCE_COUNT,
} from '../../lib/attendanceVisibility';
import { Event } from './types';

let container: HTMLDivElement | null = null; let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); container = null; root = null; availabilityRows = []; });
async function mount(node: React.ReactNode) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const EVENT = {
  id: 'e1', title: 'TIG Paint & Play', category: 'Sports', categoryIcon: '', date: '2099-01-01', time: '14:00', endTime: '20:00',
  venue: 'Play Park', area: 'Ikeja', city: 'Lagos', state: 'Lagos', country: 'NG', price: 5000, image: '', images: [],
  description: '', organizer: 'Org', isFeatured: false, isTrending: false, attendees: 0, capacity: 100, rating: 0, reviewCount: 0,
  event_date: new Date(Date.now() + 30 * 86400000).toISOString(), organizer_id: 'org-1',
  ticketTypes: [
    { id: 'reg', name: 'Regular', description: 'Entry', price: 5000, available: 10 },
    { id: 'vip', name: 'VIP', description: 'Front row', price: 20000, available: 5 },
  ],
} as unknown as Event;

describe('shared helpers', () => {
  it('a row without the column (before 0221) or with true shows the count; only false hides it', () => {
    expect(DEFAULT_SHOW_ATTENDANCE_COUNT).toBe(true);
    expect(rowShowsAttendanceCount({})).toBe(true);
    expect(rowShowsAttendanceCount({ show_attendance_count: null })).toBe(true);
    expect(rowShowsAttendanceCount({ show_attendance_count: true })).toBe(true);
    expect(rowShowsAttendanceCount({ show_attendance_count: false })).toBe(false);
    expect(rowShowsAttendanceCount(null)).toBe(true);
  });
  it('the organizer and admins may always see the count; others only when it is shown', () => {
    expect(canViewAttendanceCount(false, {})).toBe(false);
    expect(canViewAttendanceCount(false, { isEventOwner: true })).toBe(true);
    expect(canViewAttendanceCount(false, { isAdmin: true })).toBe(true);
    expect(canViewAttendanceCount(true, {})).toBe(true);
    expect(canViewAttendanceCount(undefined, {})).toBe(true);
  });
  it('recognises only a missing show_attendance_count column', () => {
    expect(isMissingAttendanceColumnError({ code: 'PGRST204', message: "Could not find the 'show_attendance_count' column of 'events' in the schema cache" })).toBe(true);
    expect(isMissingAttendanceColumnError({ code: '42703', message: 'column "show_attendance_count" of relation "events" does not exist' })).toBe(true);
    expect(isMissingAttendanceColumnError({ code: 'PGRST204', message: "Could not find the 'title' column" })).toBe(false);
    expect(isMissingAttendanceColumnError({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isMissingAttendanceColumnError(null)).toBe(false);
  });
});

describe('feed / search / saved lists (mapDbEventToFrontend)', () => {
  it('carries the setting; a row without it keeps the count shown', () => {
    expect(mapDbEventToFrontend({ id: 'a', title: 't', location: 'v, s, c', show_attendance_count: false }).showAttendanceCount).toBe(false);
    expect(mapDbEventToFrontend({ id: 'a', title: 't', location: 'v, s, c', show_attendance_count: true }).showAttendanceCount).toBe(true);
    expect(mapDbEventToFrontend({ id: 'a', title: 't', location: 'v, s, c' }).showAttendanceCount).toBe(true);
  });
});

describe('Home feed card', () => {
  const card = (event: Event) => <FeedCard event={event} onPress={() => {}} isSaved={false} onToggleSave={() => {}} />;
  it('shows the sales badge for a shown count with strong sales', async () => {
    await mount(card({ ...EVENT, bookingsCount: 80, showAttendanceCount: true } as Event));
    expect(container!.textContent).toContain('Selling Fast!');
    expect(container!.textContent).toContain('TIG Paint & Play');
  });
  it('never shows a sales badge for a hidden count (and the card still renders normally)', async () => {
    await mount(card({ ...EVENT, bookingsCount: 80, showAttendanceCount: false } as Event));
    expect(container!.textContent).not.toContain('Selling Fast!');
    expect(container!.textContent).toContain('TIG Paint & Play');
  });
});

describe('ticket picker (get_event_ticket_type_availability)', () => {
  const screen = () => <TicketSelectScreen event={EVENT} onBack={() => {}} onContinue={() => {}} />;
  it('count shown: live "N available" per tier', async () => {
    availabilityRows = [{ ticket_type: 'Regular', sold_count: 4, sold_out: false }, { ticket_type: 'VIP', sold_count: 0, sold_out: false }];
    await mount(screen());
    expect(container!.textContent).toContain('6 available');
    expect(container!.textContent).toContain('5 available');
  });
  it('count hidden: no number is shown, sold-out state still is, and an available tier stays selectable', async () => {
    availabilityRows = [{ ticket_type: 'Regular', sold_count: null, sold_out: false }, { ticket_type: 'VIP', sold_count: null, sold_out: true }];
    await mount(screen());
    expect(container!.textContent).not.toMatch(/\d+ available/);
    expect(container!.textContent).toContain('Available');
    expect(container!.textContent).toContain('Sold Out');
  });
  it('before 0221 (no sold_out column) behaves exactly as before', async () => {
    availabilityRows = [{ ticket_type: 'Regular', sold_count: 10 }, { ticket_type: 'VIP', sold_count: 1 }];
    await mount(screen());
    expect(container!.textContent).toContain('Sold Out');      // Regular: 10 - 10
    expect(container!.textContent).toContain('4 available');   // VIP: 5 - 1
  });
});
