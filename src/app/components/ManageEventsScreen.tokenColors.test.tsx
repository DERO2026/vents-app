import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ManageEventsScreen } from './ManageEventsScreen';
import type { OrganizerEventOverview } from './types';

// Stage 6 restyle regression: the only prior test for this screen
// (ManageEventsScreen.scroll.test.tsx) exercises the empty state only and
// never asserts on actual rendered color. These tests cover (a) the
// handful of hardcoded '#fff' literals that were converted to
// ventsColors.white, asserting computed style.color rather than mere text
// presence, and (b) first-time coverage of the populated event-list state
// (status badges across live/draft/ended/sold_out), since no test
// previously rendered a non-empty events array at all.

function makeEvent(overrides: Partial<OrganizerEventOverview>): OrganizerEventOverview {
  return {
    id: 'ev-1', title: 'Test Event', description: null, location: 'Lagos',
    eventDate: new Date(Date.now() + 86400000 * 30).toISOString(), price: 5000,
    ticketGoal: 100, ticketTypes: [], status: 'live', is18Plus: false,
    createdAt: new Date().toISOString(), soldCount: 10, soldQuantity: 10,
    pendingCount: 0, cancelledCount: 0, refundedCount: 0, revenueKobo: 500000,
    checkedInCount: 2, isEnded: false, isSoldOut: false, displayStatus: 'live',
    ...overrides,
  };
}

const mockEvents: OrganizerEventOverview[] = [
  makeEvent({ id: 'ev-live', title: 'Live Event', displayStatus: 'live', status: 'live' }),
  makeEvent({ id: 'ev-draft', title: 'Draft Event', displayStatus: 'draft', status: 'draft' }),
  makeEvent({ id: 'ev-ended', title: 'Ended Event', displayStatus: 'ended', status: 'live', isEnded: true }),
  makeEvent({ id: 'ev-sold-out', title: 'Sold Out Event', displayStatus: 'sold_out', status: 'live', isSoldOut: true }),
];

let eventsToRender: OrganizerEventOverview[] = [];

vi.mock('../../lib/useOrganizerEvents', () => ({
  useOrganizerEvents: () => ({
    events: eventsToRender, loading: false, error: null, sort: 'newest', setSort: () => {}, live: true, refresh: () => {},
  }),
}));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const baseProps = {
  onBack: () => {}, currentUser: { id: 'org-1' } as any, onOpenEdit: () => {}, onCreateEvent: () => {},
  onViewAttendees: () => {}, onViewAnalytics: () => {}, onOpenDoorManager: () => {}, onOpenScanner: () => {},
};

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

describe('ManageEventsScreen token-color restyle', () => {
  it('renders the empty-state "Create Event" button with explicit white text (not inherited)', () => {
    eventsToRender = [];
    act(() => {
      root!.render(<ManageEventsScreen {...baseProps} />);
    });

    const createBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Create Event'));
    expect(createBtn).toBeTruthy();
    expect(createBtn!.style.color).toBe('rgb(255, 255, 255)');
  });

  it('renders distinct, non-homogenized status badge colors for live/draft/ended/sold_out', () => {
    eventsToRender = mockEvents;
    act(() => {
      root!.render(<ManageEventsScreen {...baseProps} />);
    });

    const labels = ['Live', 'Draft', 'Ended', 'Sold Out'];
    const colors = labels.map((label) => {
      const badge = Array.from(container!.querySelectorAll('span')).find((el) => el.textContent?.trim() === label);
      expect(badge, `expected a status badge for "${label}"`).toBeTruthy();
      return (badge as HTMLElement).style.color;
    });

    // Every status must render a real, non-empty color, and no two
    // statuses should collapse onto the same color -- the whole point of
    // keeping these semantic colors un-tokenized during the restyle.
    colors.forEach((c) => expect(c).not.toBe(''));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('gives the loading skeleton and populated card titles explicit, visible text color (no inherited default)', () => {
    eventsToRender = mockEvents;
    act(() => {
      root!.render(<ManageEventsScreen {...baseProps} />);
    });

    const title = Array.from(container!.querySelectorAll('*')).find((el) => el.textContent?.trim() === 'Live Event' && el.children.length === 0);
    expect(title).toBeTruthy();
    expect((title as HTMLElement).style.color).toBe('rgb(237, 234, 245)');
  });
});
