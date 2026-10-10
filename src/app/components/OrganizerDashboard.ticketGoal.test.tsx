import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { OrganizerDashboard } from './OrganizerDashboard';

// Regression test for a real fabricated-metric bug: an event with no
// ticket_goal set used to fall back to a hardcoded `500` in the "Tickets
// Sold vs Goal" chart -- showing a goal the organizer never set, and
// potentially a false "you hit your goal" (green bar) read against a
// number nobody chose. Fixed to render no goal bar at all for such an
// event, with an honest caption, rather than inventing one.

vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

const EVENTS = [
  { id: 'e1', title: 'Real Goal Event', organizer_id: 'org-1', deleted_at: null, ticket_goal: 200, created_at: '2026-01-01', status: 'published', hidden_by_admin: false, start_date: '2027-01-01' },
  { id: 'e2', title: 'No Goal Event', organizer_id: 'org-1', deleted_at: null, ticket_goal: null, created_at: '2026-01-02', status: 'published', hidden_by_admin: false, start_date: '2027-01-02' },
];

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const chain: any = {};
      ['select', 'eq', 'is', 'order', 'limit'].forEach((m) => { chain[m] = vi.fn(() => chain); });
      chain.then = (resolve: any) => Promise.resolve({ data: EVENTS, error: null }).then(resolve);
      return chain;
    }),
    rpc: vi.fn((name: string) => {
      if (name === 'get_event_ticket_stats') {
        return Promise.resolve({
          data: [
            { event_id: 'e1', sold_quantity: 50, revenue_kobo: 500000 },
            { event_id: 'e2', sold_quantity: 10, revenue_kobo: 100000 },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    }),
  },
}));

// recharts' ResponsiveContainer uses ResizeObserver, which jsdom doesn't
// implement -- a no-op stub is enough since this test only checks text
// content, not real layout.
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<OrganizerDashboard currentUser={{ id: 'org-1', email: 'org@vents.test', full_name: 'Org', role: 'organizer' }} setActiveView={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('OrganizerDashboard: no fabricated ticket-goal fallback', () => {
  it('shows an honest "no goal set" caption instead of inventing a 500 goal for an event with none', async () => {
    await mount();
    expect(container!.textContent).toContain('No goal bar is shown for an event with no ticket goal set.');
  });

  it('never renders the literal fabricated default of 500 as a goal value anywhere in the chart data', async () => {
    await mount();
    // The real goal (200) is a genuine value from the mocked event and is
    // fine to appear; 500 was only ever the fabricated fallback and must
    // never appear as a goal now that ticket_goal is null for e2.
    expect(container!.textContent).not.toMatch(/\b500\b/);
  });
});
