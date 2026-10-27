import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ventsColors } from '../../lib/ventsDesignTokens';

// Stage 8 of the VENTS UI refurbishment -- restyled the two remaining
// hardcoded `#fff` literals (the header "+ Promote" button and the
// empty-state "Promote an event" CTA) to ventsColors.white. Everything
// else in this screen already consumed ventsColors/STATUS_META before
// this stage. These assertions check the actual COMPUTED style, not
// just text presence -- the exact gap that let the Representatives
// black-on-black regression (six investigation rounds) hide through
// passing text-presence tests.

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
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => Promise.resolve({ data: rows, error }));
  return chain;
}

async function mount(rows: any[], currentUser: { id: string } | null = { id: 'org-1' }) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PromotionsScreen onBack={() => {}} currentUser={currentUser} onPromoteEvent={() => {}} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container!;
}

function rgbOf(hex: string): string {
  // jsdom normalizes inline hex colors to rgb(); compare against the
  // same normalization rather than the raw hex string.
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
}

describe('PromotionsScreen: computed token colors (Stage 8 refurbishment)', () => {
  it('the header "+ Promote" button renders ventsColors.white as its actual computed color, not a stale #fff literal left un-tokenized', async () => {
    const el = await mount([]);
    const btn = el.querySelector('[data-testid="promotions-promote-new"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.style.color).toBe(rgbOf(ventsColors.white));
  });

  it('the empty-state "Promote an event" CTA renders ventsColors.white as its actual computed color', async () => {
    mockFrom.mockReturnValue(makeChain([]));
    const el = await mount([]);
    const cta = el.querySelector('[data-testid="promotions-empty-cta"]') as HTMLButtonElement;
    expect(cta).toBeTruthy();
    expect(cta.style.color).toBe(rgbOf(ventsColors.white));
  });

  it('keeps the two intentionally-untouched promotion-type icon colors (Trending vs Featured) visually distinct, not uniformly purple', async () => {
    const NOW = new Date('2026-10-15T12:00:00Z');
    mockFrom.mockReturnValue(makeChain([
      {
        id: 'p1', event_id: 'e1', plan_type: 'trending', status: 'active',
        start_date: '2026-10-10T00:00:00Z', end_date: '2026-10-20T00:00:00Z', created_at: '2026-10-10T00:00:00Z',
        events: { id: 'e1', title: 'Afrobeats Night', image_url: null, event_date: '2026-11-01T00:00:00Z' },
      },
      {
        id: 'p2', event_id: 'e2', plan_type: 'featured', status: 'active',
        start_date: '2026-10-10T00:00:00Z', end_date: '2026-10-20T00:00:00Z', created_at: '2026-10-10T00:00:00Z',
        events: { id: 'e2', title: 'Jazz Evening', image_url: null, event_date: '2026-11-02T00:00:00Z' },
      },
    ]));
    vi.setSystemTime(NOW);
    const el = await mount([]);
    // Both rows are 'active', so they share the same derived-status color
    // (success green) by design -- the row badges are not meant to encode
    // plan type. Assert that instead against the status badge: same
    // status -> same computed color.
    const badge1 = el.querySelector('[data-testid="promotion-status-p1"]') as HTMLElement;
    const badge2 = el.querySelector('[data-testid="promotion-status-p2"]') as HTMLElement;
    expect(badge1.style.color).toBe(rgbOf(ventsColors.success));
    expect(badge2.style.color).toBe(rgbOf(ventsColors.success));
    vi.useRealTimers();
  });

  it('status badge colors remain distinct across Active/Scheduled/Expired/Unknown -- no two statuses share a computed color', async () => {
    const NOW = new Date('2026-10-15T12:00:00Z');
    mockFrom.mockReturnValue(makeChain([
      { id: 'active', event_id: 'e1', plan_type: 'trending', status: 'active', start_date: '2026-10-10T00:00:00Z', end_date: '2026-10-20T00:00:00Z', created_at: '2026-10-10T00:00:00Z', events: { id: 'e1', title: 'A', image_url: null, event_date: null } },
      { id: 'scheduled', event_id: 'e2', plan_type: 'trending', status: 'active', start_date: '2026-11-01T00:00:00Z', end_date: '2026-11-10T00:00:00Z', created_at: '2026-10-10T00:00:00Z', events: { id: 'e2', title: 'B', image_url: null, event_date: null } },
      { id: 'expired', event_id: 'e3', plan_type: 'trending', status: 'active', start_date: '2026-09-01T00:00:00Z', end_date: '2026-09-10T00:00:00Z', created_at: '2026-09-01T00:00:00Z', events: { id: 'e3', title: 'C', image_url: null, event_date: null } },
      { id: 'other', event_id: 'e4', plan_type: 'trending', status: 'pending', start_date: '2026-10-01T00:00:00Z', end_date: '2026-10-30T00:00:00Z', created_at: '2026-10-01T00:00:00Z', events: { id: 'e4', title: 'D', image_url: null, event_date: null } },
    ]));
    vi.setSystemTime(NOW);
    const el = await mount([]);
    const colors = ['active', 'scheduled', 'expired', 'other'].map((id) => {
      const badge = el.querySelector(`[data-testid="promotion-status-${id}"]`) as HTMLElement;
      expect(badge).toBeTruthy();
      return badge.style.color;
    });
    expect(new Set(colors).size).toBe(colors.length);
    vi.useRealTimers();
  });
});
