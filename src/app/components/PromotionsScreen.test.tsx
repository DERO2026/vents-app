import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// VENTS Phase 7 -- Creator Studio Promotions management. Before this, no
// screen anywhere let an organizer see which of their events currently
// have an active Trending/Featured promotion, or when it expires
// (confirmed gap from the Phase 4 audit). This proves: ownership
// filtering (the query is always scoped to the current organizer, since
// event_promotions' own SELECT RLS policy is public), status derivation
// purely from start_date/end_date vs now (Active/Scheduled/Expired, the
// same comparison App.tsx's own Home/Explore query already uses -- no
// client-invented status), the empty state with its promote-event CTA,
// and that a historical Spotlight/'boosted' row still renders correctly
// even though it is no longer purchasable.

vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (...args: any[]) => mockFrom(...args) },
}));

import { PromotionsScreen } from './PromotionsScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  mockFrom.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

function makeChain(rows: any[], error: any = null) {
  const chain: any = {};
  let eqCalledWith: any = null;
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn((col: string, val: any) => { eqCalledWith = { col, val }; return chain; });
  chain.order = vi.fn(() => Promise.resolve({ data: rows, error }));
  chain.__eqCalledWith = () => eqCalledWith;
  return chain;
}

async function mount(rows: any[], currentUser: { id: string } | null = { id: 'org-1' }, onPromoteEvent = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PromotionsScreen onBack={() => {}} currentUser={currentUser} onPromoteEvent={onPromoteEvent} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onPromoteEvent };
}

describe('PromotionsScreen: ownership scoping', () => {
  it('queries event_promotions filtered to the current organizer’s own id', async () => {
    const chain = makeChain([]);
    mockFrom.mockReturnValue(chain);
    await mount([], { id: 'org-42' });
    expect(mockFrom).toHaveBeenCalledWith('event_promotions');
    expect(chain.eq).toHaveBeenCalledWith('organizer_id', 'org-42');
  });

  it('never fetches at all when there is no signed-in user', async () => {
    await mount([], null);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('PromotionsScreen: empty state', () => {
  it('shows a clear message and a promote-event action when the organizer has no promotions', async () => {
    mockFrom.mockReturnValue(makeChain([]));
    const { onPromoteEvent } = await mount([]);
    expect(container!.textContent).toContain('No promotions yet');
    const cta = container!.querySelector('[data-testid="promotions-empty-cta"]') as HTMLButtonElement;
    expect(cta).toBeTruthy();
    act(() => { cta.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onPromoteEvent).toHaveBeenCalledTimes(1);
  });
});

describe('PromotionsScreen: status derivation from real dates, not invented', () => {
  const NOW = new Date('2026-10-15T12:00:00Z');

  it('a row whose window contains now is Active, with a remaining-time readout', async () => {
    mockFrom.mockReturnValue(makeChain([
      {
        id: 'p1', event_id: 'e1', plan_type: 'trending', status: 'active',
        start_date: '2026-10-10T00:00:00Z', end_date: '2026-10-20T00:00:00Z', created_at: '2026-10-10T00:00:00Z',
        events: { id: 'e1', title: 'Afrobeats Night', image_url: null, event_date: '2026-11-01T00:00:00Z' },
      },
    ]));
    vi.setSystemTime(NOW);
    await mount([]);
    expect(container!.querySelector('[data-testid="promotion-status-p1"]')?.textContent).toBe('Active');
    expect(container!.textContent).toContain('days left');
    vi.useRealTimers();
  });

  it('a row whose end_date is in the past is Expired, not Active', async () => {
    mockFrom.mockReturnValue(makeChain([
      {
        id: 'p2', event_id: 'e2', plan_type: 'featured', status: 'active',
        start_date: '2026-09-01T00:00:00Z', end_date: '2026-09-10T00:00:00Z', created_at: '2026-09-01T00:00:00Z',
        events: { id: 'e2', title: 'Old Event', image_url: null, event_date: '2026-09-15T00:00:00Z' },
      },
    ]));
    vi.setSystemTime(NOW);
    await mount([]);
    expect(container!.querySelector('[data-testid="promotion-status-p2"]')?.textContent).toBe('Expired');
    vi.useRealTimers();
  });

  it('a row whose start_date is in the future is Scheduled, not Active', async () => {
    mockFrom.mockReturnValue(makeChain([
      {
        id: 'p3', event_id: 'e3', plan_type: 'trending', status: 'active',
        start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-10T00:00:00Z', created_at: '2026-10-15T00:00:00Z',
        events: { id: 'e3', title: 'Future Fest', image_url: null, event_date: '2026-11-15T00:00:00Z' },
      },
    ]));
    vi.setSystemTime(NOW);
    await mount([]);
    expect(container!.querySelector('[data-testid="promotion-status-p3"]')?.textContent).toBe('Scheduled');
    expect(container!.textContent).toContain('Starts');
    vi.useRealTimers();
  });

  it('a non-"active" raw status value is shown as "Unknown" rather than reinterpreted as Active/Expired', async () => {
    mockFrom.mockReturnValue(makeChain([
      {
        id: 'p4', event_id: 'e4', plan_type: 'trending', status: 'pending',
        start_date: '2026-10-01T00:00:00Z', end_date: '2026-10-30T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
        events: { id: 'e4', title: 'Pending Thing', image_url: null, event_date: '2026-10-31T00:00:00Z' },
      },
    ]));
    vi.setSystemTime(NOW);
    await mount([]);
    expect(container!.querySelector('[data-testid="promotion-status-p4"]')?.textContent).toBe('Unknown');
    vi.useRealTimers();
  });
});

describe('PromotionsScreen: historical Spotlight/‘boosted’ rows still display correctly', () => {
  it('renders a historical boosted-plan row with the "Spotlight" label, even though it’s no longer purchasable', async () => {
    mockFrom.mockReturnValue(makeChain([
      {
        id: 'p5', event_id: 'e5', plan_type: 'boosted', status: 'active',
        start_date: '2026-10-01T00:00:00Z', end_date: '2026-12-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
        events: { id: 'e5', title: 'Legacy Boosted Event', image_url: null, event_date: '2026-12-05T00:00:00Z' },
      },
    ]));
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    await mount([]);
    expect(container!.textContent).toContain('Spotlight');
    expect(container!.textContent).toContain('Legacy Boosted Event');
    vi.useRealTimers();
  });
});

describe('PromotionsScreen: load error', () => {
  it('shows an error message and a retry action if the query fails, never a blank/empty-state screen pretending there are no promotions', async () => {
    mockFrom.mockReturnValue(makeChain([], new Error('network down')));
    await mount([]);
    expect(container!.querySelector('[data-testid="promotions-error"]')).toBeTruthy();
    expect(container!.querySelector('[data-testid="promotions-empty"]')).toBeFalsy();
  });
});
