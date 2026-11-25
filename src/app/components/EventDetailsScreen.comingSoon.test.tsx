import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Event page for a Coming Soon event (0224): visible, with the sales opening
// time and Notify me, but no ticket selection, no order panel and no way to
// reach checkout. When the planned time has passed the page asks the server
// to open sales and only then shows the normal purchase bar. (The server
// refuses Coming Soon purchases independently -- see
// scripts/local-pg-test/run-coming-soon-verification.sh.)

let openResult: any = { opened: false, reason: 'not_due' };
const rpc = vi.fn(async (fn: string, a: any) => {
  if (fn === 'open_event_sales') return { data: openResult, error: null };
  if (fn === 'subscribe_event_sale_alert' || fn === 'unsubscribe_event_sale_alert') return { data: { subscribed: fn.startsWith('sub') }, error: null };
  if (fn === 'ticket_fee_quote') {
    const face = Math.round(a.p_unit_price * 100); const fee = Math.round(face * 15 / 1000);
    return { data: { fee_model: 'v3_15_35', quantity: a.p_quantity, unit_face_kobo: face, face_kobo: face * a.p_quantity, service_fee_kobo: fee * a.p_quantity, discount_kobo: 0, total_kobo: (face + fee) * a.p_quantity, organizer_deduction_kobo: 0, organizer_net_kobo: 0, vents_platform_fees_kobo: 0, vents_funded_discount_kobo: 0, vents_revenue_kobo: 0, service_fee_bps: 150, organizer_deduction_bps: 350 }, error: null };
  }
  return { data: null, error: null };
});
function chain(): any {
  const result = Promise.resolve({ data: [], error: null, count: 0 });
  const handler: ProxyHandler<any> = {
    get(_t, prop) {
      if (prop === 'then') return result.then.bind(result);
      if (prop === 'catch') return result.catch.bind(result);
      if (prop === 'finally') return result.finally.bind(result);
      return () => new Proxy(() => {}, handler);
    },
    apply() { return new Proxy(() => {}, handler); },
  };
  return new Proxy(() => {}, handler);
}
vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, a: any) => rpc(fn, a),
    from: () => chain(),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
    auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) },
    storage: { from: () => chain() },
  },
}));
vi.mock('./EventMap', () => ({ EventMap: () => null }));

import { EventDetailsScreen } from './EventDetailsScreen';
import { __clearQuoteCache } from '../../lib/ticketQuote';
import { __resetSaleAlertsForTests } from '../../lib/comingSoon';

const TT = [{ id: 't-reg', name: 'Regular', price: 10000, available: 50 }, { id: 't-vip', name: 'VIP', price: 25000, available: 10 }];
const baseEvent: any = {
  id: 'e1', title: 'Afrobeats Live', organizer: 'Org', organizer_id: 'o1', image: '', images: [], date: 'Sat, 20 Dec',
  time: '8:00 PM', location: 'Lagos, Nigeria', category: 'Music', attendees: 0, description: 'x',
  event_date: new Date(Date.now() + 30 * 86400000).toISOString(), ticketTypes: TT,
  status: 'coming_soon', salesOpenAt: new Date(Date.now() + 3 * 86400000).toISOString(),
};

let container: HTMLDivElement; let root: Root; let onGetTickets: any;
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
// jsdom has no scrollIntoView; the page's section tabs call it.
if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => {};
async function render(event: any, userId?: string) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); onGetTickets = vi.fn();
  await act(async () => {
    root.render(<EventDetailsScreen event={event} onBack={() => {}} onGetTickets={onGetTickets} isSaved={false} onToggleSave={() => {}} currentUserId={userId} />);
  });
  await flush();
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockClear(); __clearQuoteCache(); __resetSaleAlertsForTests(); openResult = { opened: false, reason: 'not_due' }; });

describe('Coming Soon event page', () => {
  it('shows Coming Soon and the sales opening; no ticket selector, order panel or pay button', async () => {
    await render(baseEvent, 'u1');
    expect(q('event-coming-soon-bar')!.textContent).toMatch(/Coming Soon.*Tickets on sale/);
    expect(q('coming-soon-tickets')!.textContent).toMatch(/Tickets go on sale .* \(Nigeria time\)/);
    expect(q('coming-soon-tickets')!.textContent).toContain('Regular');
    expect(q('coming-soon-tickets')!.textContent).toContain('VIP');
    expect(container.querySelector('.edt-tickets-inline')).toBeNull();
    expect(container.querySelector('.edt-purchase-panel')).toBeNull();
    expect(q('event-bottom-selection')).toBeNull();
    expect(container.textContent).not.toMatch(/Pay ₦|Get Tickets|Book Free/);
  });

  it('no button on the page can start checkout', async () => {
    await render(baseEvent, 'u1');
    for (const b of Array.from(container.querySelectorAll('button'))) {
      if (b.getAttribute('data-testid') === 'event-notify-me') continue;
      await act(async () => { b.click(); });
    }
    expect(onGetTickets).not.toHaveBeenCalled();
  });

  it('does not ask the server to open sales before the planned time', async () => {
    await render(baseEvent, 'u1');
    expect(rpc.mock.calls.filter(([fn]) => fn === 'open_event_sales')).toHaveLength(0);
  });

  it('Notify me subscribes, then unsubscribes', async () => {
    await render(baseEvent, 'u1');
    await act(async () => { q('event-notify-me')!.click(); }); await flush();
    expect(rpc).toHaveBeenCalledWith('subscribe_event_sale_alert', { p_event_id: 'e1' });
    expect(q('event-notify-me')!.textContent).toBe('✓ Notifying you');
    await act(async () => { q('event-notify-me')!.click(); }); await flush();
    expect(rpc).toHaveBeenCalledWith('unsubscribe_event_sale_alert', { p_event_id: 'e1' });
    expect(q('event-notify-me')!.textContent).toBe('🔔 Notify me');
  });

  it('signed out: Notify me asks to sign in and calls nothing', async () => {
    await render(baseEvent, undefined);
    await act(async () => { q('event-notify-me')!.click(); }); await flush();
    expect(container.textContent).toContain('Sign in to get notified');
    expect(rpc.mock.calls.filter(([fn]) => fn === 'subscribe_event_sale_alert')).toHaveLength(0);
  });
});

describe('when the planned time has passed', () => {
  const due = { ...baseEvent, salesOpenAt: new Date(Date.now() - 60_000).toISOString() };

  it('asks the server to open sales and, once it confirms, shows the normal purchase bar', async () => {
    openResult = { opened: true, notified: 2 };
    await render(due, 'u1');
    expect(rpc).toHaveBeenCalledWith('open_event_sales', { p_event_id: 'e1' });
    expect(q('event-coming-soon-bar')).toBeNull();
    expect(q('event-bottom-selection')!.textContent).toBe('Regular × 1');
    expect(container.querySelector('.edt-bottom-bar button')!.textContent).toBe('Pay ₦10,150');
  });

  it('if the server does not open it (e.g. hidden by an admin), it stays Coming Soon', async () => {
    openResult = { opened: false, reason: 'hidden_by_admin' };
    await render(due, 'u1');
    expect(q('event-coming-soon-bar')).toBeTruthy();
    expect(q('event-bottom-selection')).toBeNull();
  });
});

describe('ordinary live events are unchanged', () => {
  it('a live event shows the normal ticket selector and pay button, no Coming Soon UI', async () => {
    await render({ ...baseEvent, status: 'live', salesOpenAt: null }, 'u1');
    expect(q('event-coming-soon-bar')).toBeNull();
    expect(q('coming-soon-tickets')).toBeNull();
    expect(container.querySelector('.edt-tickets-inline')).toBeTruthy();
    expect(q('event-bottom-selection')!.textContent).toBe('Regular × 1');
    expect(rpc.mock.calls.filter(([fn]) => fn === 'open_event_sales')).toHaveLength(0);
  });

  it('an event with no status (older cached rows) behaves as live', async () => {
    const { status: _s, salesOpenAt: _o, ...legacy } = baseEvent;
    await render(legacy, 'u1');
    expect(q('event-coming-soon-bar')).toBeNull();
    expect(q('event-bottom-selection')).toBeTruthy();
  });
});
