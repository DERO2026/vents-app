import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminAnalyticsScreen } from './AdminAnalyticsScreen';

// Regression coverage for a confirmed scalability bug: the VC-circulation
// and ticket-revenue totals used to be summed client-side from a single
// unbounded .select('amount') with no .limit()/.range() at all. Supabase's
// Data API caps how many rows one request returns (the project's "Max
// Rows" setting); once a table's matching row count exceeds that cap, the
// old single-request fetch would silently come back truncated and the
// total would silently undercount, with nothing in the UI indicating it.
// This proves the fix sums correctly across more rows than fit in one
// page -- every row across every page is counted, not just the first page.

const PAGE_SIZE = 1000;
// One full page (1000 rows of amount=1) plus a second, partial page (3
// rows of amount=1) for vc_transactions -- 1003 total, deliberately more
// than one page would hold, so a correct implementation must sum 1003 and
// a page-unaware one would silently stop at 1000.
const vcRows = Array.from({ length: PAGE_SIZE + 3 }, () => ({ amount: 1 }));
const ticketRows = [{ amount: 7000 }, { amount: 3000 }]; // single short page, sum 10000

const rangeCallsByTable: Record<string, { start: number; end: number }[]> = { vc_transactions: [], tickets: [] };

vi.mock('../../../lib/supabase', () => {
  function makeQuery(table: string) {
    let rows: any[] = [];
    const q: any = {
      select: (col: string) => {
        // Distinguish the head-count query (count:'exact', head:true has
        // no meaningful second arg here) from the amount-sum query by
        // which column name is requested.
        if (col === 'amount') rows = table === 'vc_transactions' ? vcRows : table === 'tickets' ? ticketRows : [];
        return q;
      },
      eq: () => q,
      is: () => q,
      range: (start: number, end: number) => {
        if (table === 'vc_transactions' || table === 'tickets') rangeCallsByTable[table].push({ start, end });
        return {
          then: (resolve: any) => resolve({ data: rows.slice(start, end + 1), error: null }),
        };
      },
      then: (resolve: any) => {
        if (table === 'users') return resolve({ data: null, error: null, count: 5 });
        if (table === 'events') return resolve({ data: null, error: null, count: 2 });
        if (table === 'tickets') return resolve({ data: null, error: null, count: ticketRows.length });
        return resolve({ data: [], error: null });
      },
    };
    return q;
  }
  const channelStub = { on: () => channelStub, subscribe: () => channelStub };
  return {
    supabase: {
      from: (table: string) => makeQuery(table),
      rpc: () => Promise.resolve({ data: [{ new_this_week: 0, new_this_month: 0 }], error: null }),
      channel: () => channelStub,
      removeChannel: () => {},
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rangeCallsByTable.vc_transactions = [];
  rangeCallsByTable.tickets = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('AdminAnalyticsScreen: paginated sums', () => {
  it('sums VC circulation across more than one page instead of truncating at the page size', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminAnalyticsScreen />); });
    await flush();

    expect(container.textContent).toContain((PAGE_SIZE + 3).toLocaleString());
    // Proves it actually paged rather than happening to sum right some
    // other way: more than one .range() call was made for this table.
    expect(rangeCallsByTable.vc_transactions.length).toBeGreaterThan(1);
  });

  it('sums ticket revenue correctly when it fits in a single page', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminAnalyticsScreen />); });
    await flush();

    expect(container.textContent).toContain('10,000.00');
    expect(rangeCallsByTable.tickets.length).toBe(1);
  });
});
