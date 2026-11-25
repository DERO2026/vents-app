import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Promotion eligibility (0225) in the Promote screen: only events that are
// on sale are offered, and the server's eligibility is checked BEFORE the
// Paystack popup opens -- so an organizer is never charged for a promotion
// the server would refuse. Prices and the popup call are unchanged.

const future = new Date(Date.now() + 20 * 86400000).toISOString();
const past = new Date(Date.now() - 5 * 86400000).toISOString();
const base = { organizer_id: 'org-1', deleted_at: null, hidden_by_admin: false, cancelled_at: null, end_date: null, created_at: '2026-11-01T00:00:00Z' };
let rows: any[] = [];
let eligibility: any = { data: { eligible: true, reason: null }, error: null };
const rpc = vi.fn(async (_fn: string, _a: any) => eligibility);
const popup = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ is: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }) }),
    rpc: (fn: string, a: any) => rpc(fn, a),
  },
  getAuthToken: () => Promise.resolve('token'),
}));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { track: () => {}, eventPromoted: () => {} } }));
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: popup }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

import { PromoteEventScreen, isPromotableEvent } from './PromoteEventScreen';
import { EVENT_PROMOTION_PRICES_NAIRA } from '../../lib/eventPromotionPricing';

const LIVE = { ...base, id: 'live', title: 'Live Show', status: 'live', event_date: future };
const ALL = [
  LIVE,
  { ...base, id: 'draft', title: 'Draft Show', status: 'draft', event_date: future },
  { ...base, id: 'cs', title: 'Coming Soon Show', status: 'coming_soon', event_date: future },
  { ...base, id: 'cxl', title: 'Cancelled Show', status: 'draft', event_date: future, cancelled_at: past },
  { ...base, id: 'hid', title: 'Hidden Show', status: 'live', event_date: future, hidden_by_admin: true },
  { ...base, id: 'end', title: 'Ended Show', status: 'live', event_date: past },
];

let container: HTMLDivElement; let root: Root;
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const payButton = () => Array.from(container.querySelectorAll('button')).find((b) => /Event for/.test(b.textContent || '')) as HTMLButtonElement;
async function mount(initialEventId?: string) {
  await act(async () => { root.render(<PromoteEventScreen onBack={() => {}} currentUser={{ id: 'org-1', email: 'o@example.test', full_name: 'Org', role: 'organizer' }} initialEventId={initialEventId} />); });
  await flush();
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); rows = ALL; popup.mockReset(); rpc.mockClear(); eligibility = { data: { eligible: true, reason: null }, error: null }; });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('isPromotableEvent (mirrors event_promotion_block_reason)', () => {
  it('only a live, not-cancelled, not-hidden, not-ended event', () => {
    expect(ALL.filter(isPromotableEvent).map((e) => e.id)).toEqual(['live']);
  });
});

describe('Promote screen', () => {
  it('offers only promotable events, even when opened for an ineligible one', async () => {
    await mount('cs');
    expect(container.textContent).toContain('Live Show');
    for (const t of ['Draft Show', 'Coming Soon Show', 'Cancelled Show', 'Hidden Show', 'Ended Show']) expect(container.textContent).not.toContain(t);
  });

  it('eligible: checks with the server, then opens Paystack for the unchanged plan price', async () => {
    await mount('live');
    await act(async () => { payButton().click(); });
    await flush();
    expect(rpc).toHaveBeenCalledWith('get_event_promotion_eligibility', { p_event_id: 'live' });
    expect(popup).toHaveBeenCalledTimes(1);
    expect(popup.mock.calls[0][0]).toMatchObject({ amountNaira: EVENT_PROMOTION_PRICES_NAIRA.featured[7], metadata: { event_id: 'live', plan: 'featured', duration: 7 } });
  });

  it('server says not eligible (e.g. it became Coming Soon/cancelled meanwhile): no payment is started', async () => {
    eligibility = { data: { eligible: false, reason: 'not_on_sale' }, error: null };
    await mount('live');
    await act(async () => { payButton().click(); });
    await flush();
    expect(popup).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Only events that are on sale can be promoted');
    expect(payButton().disabled).toBe(false);
  });

  it('server check fails (network): no payment is started', async () => {
    eligibility = { data: null, error: { code: '500', message: 'boom' } };
    await mount('live');
    await act(async () => { payButton().click(); });
    await flush();
    expect(popup).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Could not confirm this event can be promoted');
  });

  it('database without 0225 (function missing): falls back to the client rule for a live event', async () => {
    eligibility = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    await mount('live');
    await act(async () => { payButton().click(); });
    await flush();
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('no promotable events: explains why, and paying does nothing', async () => {
    rows = ALL.filter((e) => e.id !== 'live');
    await mount();
    expect(container.textContent).toContain('No events can be promoted right now');
    await act(async () => { payButton().click(); });
    await flush();
    expect(popup).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
