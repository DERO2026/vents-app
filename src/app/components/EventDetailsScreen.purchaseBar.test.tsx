import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// The event page purchase bar shows the SELECTED ticket category and quantity
// and the server-quoted total -- never the cheapest category's "Buy from ₦X".
// The quote below is public.ticket_fee_quote's arithmetic (0208): attendee
// fee round(face x 1.5%), per ticket in kobo, times the quantity.
const quote = (price: number, qty: number) => {
  const face = Math.round(price * 100);
  const fee = Math.round(face * 15 / 1000);
  const ded = Math.round(face * 35 / 1000);
  return {
    fee_model: 'v3_15_35', quantity: qty, unit_face_kobo: face, face_kobo: face * qty, service_fee_kobo: fee * qty,
    discount_kobo: 0, total_kobo: (face + fee) * qty, organizer_deduction_kobo: ded * qty, organizer_net_kobo: (face - ded) * qty,
    vents_platform_fees_kobo: (fee + ded) * qty, vents_funded_discount_kobo: 0, vents_revenue_kobo: (fee + ded) * qty,
    service_fee_bps: 150, organizer_deduction_bps: 350,
  };
};
const rpc = vi.fn(async (fn: string, a: any) => (fn === 'ticket_fee_quote'
  ? { data: quote(a.p_unit_price, a.p_quantity), error: null }
  : { data: null, error: null }));
function chain(): any {
  const result = Promise.resolve({ data: null, error: null, count: 0 });
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

const baseEvent: any = {
  id: 'e1', title: 'Night Out', organizer: 'Org', organizerId: 'o1', image: '', images: [], date: 'Sat, 20 Dec',
  time: '8:00 PM', location: 'Lagos, Nigeria', category: 'Party', attendees: 0, description: 'x',
  event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
};

let container: HTMLDivElement; let root: Root;
async function render(ticketTypes: any[]) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<EventDetailsScreen event={{ ...baseEvent, ticketTypes }} onBack={() => {}} onGetTickets={() => {}} isSaved={false} onToggleSave={() => {}} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const bottomButton = () => container.querySelector('.edt-bottom-bar button')?.textContent ?? '';
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockClear(); __clearQuoteCache(); });

const GUYS = { id: 't-guys', name: 'Guys', price: 70000, available: 50 };
const LADIES = { id: 't-ladies', name: 'Ladies', price: 20000, available: 50 };

describe('event page purchase bar', () => {
  it('shows the selected category and its server total, not "Buy from" the cheapest', async () => {
    await render([GUYS, LADIES]);
    expect(q('event-bottom-selection')).toBe('Guys × 1');
    expect(bottomButton()).toBe('Pay ₦71,050');
    expect(container.textContent).not.toMatch(/Buy from/);
  });

  it('switching category updates the label and total (Ladies × 1 → ₦20,300)', async () => {
    await render([GUYS, LADIES]);
    const ladies = Array.from(container.querySelectorAll('.edt-tickets-inline div')).find((d) => d.textContent?.startsWith('Ladies')) as HTMLElement;
    await act(async () => { ladies.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(q('event-bottom-selection')).toBe('Ladies × 1');
    expect(bottomButton()).toBe('Pay ₦20,300');
  });

  it('quantity changes update the total immediately (Ladies × 2 → ₦40,600)', async () => {
    await render([LADIES]);
    const plus = Array.from(container.querySelectorAll('.edt-tickets-inline button')).pop() as HTMLButtonElement;
    await act(async () => { plus.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(q('event-bottom-selection')).toBe('Ladies × 2');
    expect(bottomButton()).toBe('Pay ₦40,600');
    expect(q('event-order-subtotal')).toBe('₦40,000');
    expect(q('event-order-fee')).toBe('₦600');
    expect(q('event-order-total')).toBe('₦40,600');
  });

  it('pre-selects the first AVAILABLE category; a sold-out first category is skipped', async () => {
    await render([{ ...GUYS, available: 0 }, LADIES]);
    expect(q('event-bottom-selection')).toBe('Ladies × 1');
    expect(bottomButton()).toBe('Pay ₦20,300');
  });

  it('when every category is sold out nothing can be bought', async () => {
    await render([{ ...GUYS, available: 0 }, { ...LADIES, available: 0 }]);
    expect(q('event-bottom-selection')).toBe('Sold out');
    expect(bottomButton()).toBe('Sold out');
    expect((container.querySelector('.edt-bottom-bar button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('zero quantity cannot be paid', async () => {
    await render([LADIES]);
    const minus = Array.from(container.querySelectorAll('.edt-tickets-inline button'))[0] as HTMLButtonElement;
    await act(async () => { minus.click(); });
    expect(q('event-bottom-selection')).toBe('Ladies × 0');
    expect(bottomButton()).toBe('Choose a quantity');
    expect((container.querySelector('.edt-bottom-bar button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a free ticket books without a paid checkout amount', async () => {
    await render([{ id: 't-free', name: 'Free entry', price: 0, available: 10 }]);
    expect(q('event-bottom-selection')).toBe('Free entry × 1');
    expect(bottomButton()).toBe('Book Free Ticket');
    expect(rpc.mock.calls.filter(([fn]) => fn === 'ticket_fee_quote')).toHaveLength(0);
  });

  it('shows the one-category-per-order rule when there is more than one category', async () => {
    await render([GUYS, LADIES]);
    expect(q('one-category-note')).toMatch(/One ticket category per order/);
  });

  it('never shows the organizer deduction to the attendee', async () => {
    await render([GUYS]);
    expect(container.textContent).not.toMatch(/deduction|3\.5%|commission/i);
  });
});
