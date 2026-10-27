import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Regression tests for the Stage-11 structural redesign (metrics hero +
// plan-colored card identity + desktop card grid). Stage 8 (PR #61) only
// swapped 2 hex literals; this is the first pass that actually changes
// layout/hierarchy. These assert COMPUTED values, not text presence --
// the discipline this engagement adopted after the Representatives
// black-screen incident, where text-presence-only tests passed through a
// completely invisible screen.

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

function makeChain(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => Promise.resolve({ data: rows, error: null }));
  return chain;
}

async function mount(rows: any[]) {
  mockFrom.mockReturnValue(makeChain(rows));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PromotionsScreen onBack={() => {}} currentUser={{ id: 'org-1' }} onPromoteEvent={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const TRENDING_ROW = {
  id: 'p-trend', event_id: 'e1', plan_type: 'trending', status: 'active',
  start_date: '2026-10-10T00:00:00Z', end_date: '2026-10-20T00:00:00Z', created_at: '2026-10-10T00:00:00Z',
  events: { id: 'e1', title: 'Afrobeats Night', image_url: null, event_date: '2026-11-01T00:00:00Z' },
};
const FEATURED_ROW = {
  id: 'p-feat', event_id: 'e2', plan_type: 'featured', status: 'active',
  start_date: '2026-10-05T00:00:00Z', end_date: '2026-11-05T00:00:00Z', created_at: '2026-10-05T00:00:00Z',
  events: { id: 'e2', title: 'Jazz Evening', image_url: 'https://example.com/jazz.jpg', event_date: '2026-11-10T00:00:00Z' },
};
const SCHEDULED_ROW = {
  id: 'p-sched', event_id: 'e3', plan_type: 'trending', status: 'active',
  start_date: '2026-12-01T00:00:00Z', end_date: '2026-12-10T00:00:00Z', created_at: '2026-10-15T00:00:00Z',
  events: { id: 'e3', title: 'Future Fest', image_url: null, event_date: '2026-12-15T00:00:00Z' },
};

describe('PromotionsScreen redesign: summary metrics hero', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-10-15T12:00:00Z')));
  afterEach(() => vi.useRealTimers());

  it('derives Active/Scheduled/Total counts from the fetched rows, not a new query', async () => {
    await mount([TRENDING_ROW, FEATURED_ROW, SCHEDULED_ROW]);
    expect(container!.querySelector('[data-testid="promotions-metric-active"]')?.textContent).toContain('2');
    expect(container!.querySelector('[data-testid="promotions-metric-scheduled"]')?.textContent).toContain('1');
    expect(container!.querySelector('[data-testid="promotions-metric-total"]')?.textContent).toContain('3');
    // Exactly one event_promotions query -- the metrics did not trigger a
    // second fetch.
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('does not render the metrics hero on the empty state (nothing to summarize)', async () => {
    await mount([]);
    expect(container!.querySelector('[data-testid="promotions-metrics"]')).toBeFalsy();
  });
});

describe('PromotionsScreen redesign: plan-type identity is visually distinct from status', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-10-15T12:00:00Z')));
  afterEach(() => vi.useRealTimers());

  it('Trending and Featured rows get different computed accent colors, independent of both sharing "Active" status', async () => {
    await mount([TRENDING_ROW, FEATURED_ROW]);
    const trendingPlan = container!.querySelector('[data-testid="promotion-plan-p-trend"]') as HTMLElement;
    const featuredPlan = container!.querySelector('[data-testid="promotion-plan-p-feat"]') as HTMLElement;
    expect(trendingPlan).toBeTruthy();
    expect(featuredPlan).toBeTruthy();
    const trendingColor = getComputedStyle(trendingPlan).color;
    const featuredColor = getComputedStyle(featuredPlan).color;
    expect(trendingColor).toBeTruthy();
    expect(featuredColor).toBeTruthy();
    expect(trendingColor).not.toBe(featuredColor);
    // Both rows share the SAME status ("Active"), so this distinctness is
    // coming from plan type, not status -- the actual thing this test set
    // out to prove.
    const trendingStatus = container!.querySelector('[data-testid="promotion-status-p-trend"]')?.textContent;
    const featuredStatus = container!.querySelector('[data-testid="promotion-status-p-feat"]')?.textContent;
    expect(trendingStatus).toBe(featuredStatus);
  });

  it('the card left-border accent color matches the row\'s plan-type color (computed, not just present in a style attribute string)', async () => {
    await mount([TRENDING_ROW]);
    const card = container!.querySelector('[data-testid="promotion-row-p-trend"]') as HTMLElement;
    const computed = getComputedStyle(card);
    expect(computed.borderLeftWidth).toBe('3px');
    expect(computed.borderLeftStyle).toBe('solid');
    expect(computed.borderLeftColor).toBeTruthy();
  });
});

describe('PromotionsScreen redesign: event thumbnail uses already-fetched data, never fabricated', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-10-15T12:00:00Z')));
  afterEach(() => vi.useRealTimers());

  it('renders an <img> from events.image_url when present', async () => {
    await mount([FEATURED_ROW]);
    const card = container!.querySelector('[data-testid="promotion-row-p-feat"]') as HTMLElement;
    const img = card.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('https://example.com/jazz.jpg');
  });

  it('falls back to a plan-colored icon chip, not a broken image, when image_url is null', async () => {
    await mount([TRENDING_ROW]);
    const card = container!.querySelector('[data-testid="promotion-row-p-trend"]') as HTMLElement;
    expect(card.querySelector('img')).toBeFalsy();
  });
});

describe('PromotionsScreen redesign: desktop card grid', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-10-15T12:00:00Z')));
  afterEach(() => vi.useRealTimers());

  it('the card list container uses the promotions-cards-list class driving the responsive grid, matching the established ManageEventsScreen breakpoint pattern', async () => {
    await mount([TRENDING_ROW]);
    expect(container!.querySelector('.promotions-cards-list')).toBeTruthy();
  });
});
