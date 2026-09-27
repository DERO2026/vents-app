import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { SalesAnalyticsScreen } from './SalesAnalyticsScreen';

// Regression test for the large-event scalability audit finding #3:
// PortfolioAnalyticsScreen used to fetch EVERY paid/active ticket row
// across ALL of an organizer's events with `.select('*')` and no limit,
// then reduced them in JS. This proves the screen now calls the real SQL
// aggregate (get_portfolio_analytics, 0101) instead, and renders its
// pre-aggregated totals directly.

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (...args: any[]) => fromMock(...args),
    rpc: (...args: any[]) => rpcMock(...args),
  },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: vi.fn() }));

function eventsQueryChain(rows: any[]) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    is: () => Promise.resolve({ data: rows, error: null }),
  };
  return chain;
}

const currentUser = { id: 'organizer-1', email: 'org@example.com', full_name: 'Org', role: 'organizer' };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fromMock.mockReset();
  rpcMock.mockReset();
});

async function renderScreen(portfolioResult: any) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'events') {
      return eventsQueryChain([
        { id: 'event-1', ticket_goal: 500, event_date: '2099-01-01', end_date: null, status: 'live' },
      ]);
    }
    throw new Error(`Unexpected supabase.from('${table}') call -- PortfolioAnalyticsScreen should only query 'events' directly; ticket aggregation must go through get_portfolio_analytics.`);
  });
  rpcMock.mockResolvedValueOnce({ data: portfolioResult, error: null });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SalesAnalyticsScreen currentUser={currentUser} onBack={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PortfolioAnalyticsScreen: uses the real SQL aggregate, not a raw ticket fetch', () => {
  it('calls get_portfolio_analytics with the organizer id, never supabase.from("tickets")', async () => {
    await renderScreen({
      totalRevenue: 2500,
      totalSales: 3,
      checkedInQty: 1,
      byTicketType: [{ name: 'VIP', qty: 2 }, { name: 'Regular', qty: 1 }],
      byWeekday: [{ day: 'Mon', revenue: 2000, qty: 2 }, { day: 'Tue', revenue: 500, qty: 1 }],
    });

    expect(rpcMock).toHaveBeenCalledWith('get_portfolio_analytics', { p_organizer_id: 'organizer-1' });
    // fromMock throwing on any table other than 'events' would have surfaced
    // as a caught error (Sentry.captureException) rather than a thrown test
    // failure, so explicitly assert no unexpected table was queried.
    for (const call of fromMock.mock.calls) {
      expect(call[0]).toBe('events');
    }
  });

  it('renders the pre-aggregated totals returned by the RPC directly', async () => {
    await renderScreen({
      totalRevenue: 2500,
      totalSales: 3,
      checkedInQty: 1,
      byTicketType: [{ name: 'VIP', qty: 2 }, { name: 'Regular', qty: 1 }],
      byWeekday: [{ day: 'Mon', revenue: 2000, qty: 2 }, { day: 'Tue', revenue: 500, qty: 1 }],
    });

    expect(container!.textContent).toContain('₦2,500');
    expect(container!.textContent).toContain('3'); // Tickets Sold
    // Avg attendance = checkedInQty/totalSales = 1/3 -> 33%
    expect(container!.textContent).toContain('33%');
  });

  it('renders zeroed stats (not a crash) when the organizer has no tickets at all', async () => {
    await renderScreen({ totalRevenue: 0, totalSales: 0, checkedInQty: 0, byTicketType: [], byWeekday: [] });

    expect(container!.textContent).toContain('₦0');
    expect(container!.textContent).toContain('No sales yet');
  });
});
