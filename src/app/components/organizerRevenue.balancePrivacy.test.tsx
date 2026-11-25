import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Release audit H4: organizer revenue on Manage Events and Sales Analytics
// follows the global hide-balances preference, like Total Revenue on the
// Organizer Dashboard. Ticket prices and sales counts stay visible.

const KEY = 'vents:balance-privacy:hidden';
const ev = { id: 'e1', title: 'Lagos Jazz Night', status: 'live', displayStatus: 'live', price: 5000, soldCount: 6, soldQuantity: 6, ticketGoal: 100, revenueKobo: 3150000, checkedInCount: 2, date: '2026-12-08', time: '19:00', location: 'Lagos' };
vi.mock('../../lib/useOrganizerEvents', () => ({
  useOrganizerEvents: () => ({ events: [ev], loading: false, error: null, sort: 'newest', setSort: () => {}, live: true, refresh: () => {} }),
}));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc, from }, getAuthToken: async () => 't' }));

import { ManageEventsScreen } from './ManageEventsScreen';
import { SalesAnalyticsScreen } from './SalesAnalyticsScreen';

let container: HTMLDivElement; let root: Root;
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = () => container.textContent || '';
const eye = () => container.querySelector('[data-testid="balance-visibility-toggle"], [data-testid="manage-events-balance-toggle"]') as HTMLButtonElement;

beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  rpc.mockImplementation((name: string) => {
    if (name === 'get_portfolio_analytics') return Promise.resolve({ data: { totalRevenue: 31500, totalSales: 6, checkedInQty: 2, byTicketType: [], byWeekday: [{ day: 'Mon', revenue: 21000, qty: 4 }, { day: 'Tue', revenue: 10500, qty: 2 }] }, error: null });
    if (name === 'get_event_analytics') return Promise.resolve({ data: {
      eventTitle: 'Lagos Jazz Night',
      overview: { soldQuantity: 6, ticketGoal: 100, remaining: 94, grossKobo: 3150000, buyerFeeKobo: 47250, organizerEarnedKobo: 3039750, pendingCount: 0, cancelledCount: 0, refundedCount: 0 },
      byTicketType: [{ name: 'VIP', soldCount: 2, revenueKobo: 2100000, remaining: 8 }],
      salesTrend: [{ date: '2026-11-20', count: 6, revenueKobo: 3150000 }],
      attendance: { checkedInCount: 2, soldQuantity: 6, attendancePct: 33 },
      checkinTrend: [],
    }, error: null });
    return Promise.resolve({ data: [], error: null });
  });
  const chain: any = { select: () => chain, eq: () => chain, is: () => Promise.resolve({ data: [{ id: 'e1', ticket_goal: 100, event_date: '2099-01-01', end_date: null, status: 'live' }], error: null }) };
  from.mockImplementation(() => chain);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); localStorage.removeItem(KEY); });

describe('Manage Events', () => {
  const mount = async () => {
    await act(async () => {
      root.render(<ManageEventsScreen onBack={() => {}} currentUser={{ id: 'org-1' } as any} onOpenEdit={() => {}} onCreateEvent={() => {}} onViewAttendees={() => {}} onViewAnalytics={() => {}} onOpenDoorManager={() => {}} onOpenScanner={() => {}} />);
    });
    await flush();
  };

  it('per-event revenue is masked when hidden; ticket price and sold count stay visible', async () => {
    localStorage.setItem(KEY, '1');
    await mount();
    expect(text()).not.toContain('31,500');
    expect(text()).toContain('₦••••••');
    expect(text()).toContain('5,000'); // public ticket price
    expect(text()).toContain('6/100'); // sold
  });

  it('the eye on My Events reveals it', async () => {
    localStorage.setItem(KEY, '1');
    await mount();
    await act(async () => { eye().click(); });
    expect(text()).toContain('31,500');
  });
});

describe('Sales Analytics', () => {
  it('portfolio Total Revenue and chart axis amounts are masked; counts are not', async () => {
    localStorage.setItem(KEY, '1');
    await act(async () => { root.render(<SalesAnalyticsScreen currentUser={{ id: 'org-1', email: 'o@x', full_name: 'O', role: 'organizer' } as any} onBack={() => {}} />); });
    await flush();
    expect(text()).not.toContain('31,500');
    expect(text()).toContain('₦••••••');
    const axis = Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent);
    expect(axis.filter((t) => t?.startsWith('₦'))).toEqual(['₦•••', '₦•••', '₦•••']);
    await act(async () => { eye().click(); });
    expect(text()).toContain('31,500');
  });

  it('event analytics masks gross sales, organizer earned, service fee and revenue by ticket type', async () => {
    localStorage.setItem(KEY, '1');
    await act(async () => { root.render(<SalesAnalyticsScreen currentUser={{ id: 'org-1', email: 'o@x', full_name: 'O', role: 'organizer' } as any} onBack={() => {}} eventId="e1" eventTitle="Lagos Jazz Night" />); });
    await flush();
    for (const amount of ['31,500', '30,397', '472', '21,000']) expect(text()).not.toContain(amount);
    expect(text()).toContain('2 sold'); // sales counts stay visible
    await act(async () => { eye().click(); });
    expect(text()).toContain('31,500');
    expect(text()).toContain('21,000');
  });
});
