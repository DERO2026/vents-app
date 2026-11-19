import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { CheckoutScreen } from './CheckoutScreen';
import { __clearQuoteCache } from '../../lib/ticketQuote';
import type { Event, TicketType } from './types';

// Checkout UI cleanup:
//  1. The duplicate Card/Bank (Paystack) / VENTS Wallet selector in the sticky
//     Pay area is gone; the single Payment Method section above remains.
//  2. Full name and email are required; phone is optional everywhere -- an
//     empty phone is accepted (sent as no phone), an entered phone is still
//     validated and saved in E.164.
// Paid checkout is driven to the real create_pending_purchase call so the
// payload the server receives is asserted, not just the UI.

const mockOpenPaystackPopup = vi.fn();
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: (opts: any) => mockOpenPaystackPopup(opts) }));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { checkoutStarted: () => {}, ticketPurchased: () => {} } }));
vi.mock('../../lib/haptics', () => ({ haptics: { medium: () => {}, light: () => {}, success: () => {} } }));
vi.mock('../../lib/userWallet', () => ({ fetchMyWalletBalanceKobo: () => Promise.resolve(900000), payTicketWithWallet: () => Promise.resolve({ status: 'error', error: 'not used' }) }));
vi.mock('../../lib/operationalStatus', () => ({ friendlyOperationalError: (e: any) => String(e) }));

const mockRpc = vi.fn();
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: (name: string, args: any) => mockRpc(name, args) } }));

const UNIT = 500000; const FEE = 25000;
beforeEach(() => {
  __clearQuoteCache();
  mockOpenPaystackPopup.mockReset();
  mockRpc.mockReset();
  mockRpc.mockImplementation((name: string, args: any) => {
    const qty = Number(args?.p_quantity) || 1;
    if (name === 'ticket_fee_quote') {
      return Promise.resolve({ data: { fee_model: 'v3_15_35', quantity: qty, unit_face_kobo: UNIT, face_kobo: UNIT * qty, service_fee_kobo: FEE * qty,
        discount_kobo: 0, total_kobo: (UNIT + FEE) * qty, organizer_deduction_kobo: 0, organizer_net_kobo: UNIT * qty, vents_revenue_kobo: FEE * qty,
        service_fee_bps: 500, organizer_deduction_bps: 0 }, error: null });
    }
    if (name === 'create_pending_purchase') {
      const n = Array.isArray(args?.p_attendees) ? args.p_attendees.length : 1;
      return Promise.resolve({ data: { payment_ref: 'vnt_order_1', amount_kobo: (UNIT + FEE) * n }, error: null });
    }
    if (name === 'initiate_ticket_payment_attempt') {
      const call = mockRpc.mock.calls.find((c) => c[0] === 'create_pending_purchase');
      const n = Array.isArray(call?.[1]?.p_attendees) ? call![1].p_attendees.length : 1;
      return Promise.resolve({ data: { reference: 'vnt_attempt_1', amount_kobo: (UNIT + FEE) * n }, error: null });
    }
    if (name === 'get_my_wallet') return Promise.resolve({ data: [{ balance_kobo: 900000 }], error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

const EVENT = { id: 'event-1', title: 'Test Event', image: '', price: 5000 } as unknown as Event;
const PAID: TicketType = { id: 'tt-1', name: 'Regular', price: 5000, description: '', available: 50 };
const USER = { id: 'user-1', email: 'buyer@example.com', full_name: 'Buyer Person' };

async function mount(quantity = 1) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => {
    root!.render(<CheckoutScreen event={EVENT} ticketType={PAID} quantity={quantity} currentUser={USER} onBack={() => {}} onSuccess={() => {}} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
function type(input: HTMLInputElement | null | undefined, value: string) {
  expect(input, 'input not found').toBeTruthy();
  act(() => { setter.call(input, value); input!.dispatchEvent(new Event('input', { bubbles: true })); });
}
const byPlaceholder = (p: string) => Array.from(container!.querySelectorAll<HTMLInputElement>(`input[placeholder="${p}"]`));
const buttons = () => Array.from(container!.querySelectorAll('button'));
const payButton = () => buttons().find((b) => /^Pay ₦/.test(b.textContent || ''))! as HTMLButtonElement;
async function pay() {
  await act(async () => {
    payButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}
const pendingPurchaseCall = () => mockRpc.mock.calls.find((c) => c[0] === 'create_pending_purchase');

describe('checkout: one payment selector', () => {
  it('shows the Payment Method section once and no duplicate selector in the sticky Pay area', async () => {
    await mount();
    const texts = buttons().map((b) => (b.textContent || '').trim());
    expect(texts.filter((x) => x.startsWith('Card / Bank'))).toEqual(['Card / Bank / USSD']);
    expect(texts.filter((x) => x.startsWith('VENTS Wallet'))).toHaveLength(1);
    expect(container!.textContent).toContain('Payment Method');
    expect(container!.textContent).not.toContain('Card / Bank (Paystack)');
    const panel = container!.querySelector('.checkout-summary-panel')!;
    expect(panel).toBeTruthy();
    expect(Array.from(panel.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter((t) => /Card|Wallet|Paystack/.test(t))).toEqual([]);
    expect(payButton().textContent).toMatch(/^Pay ₦/);
  });

  it('the remaining selector still switches the payment method (wallet path is used)', async () => {
    await mount();
    await act(async () => { buttons().find((b) => (b.textContent || '').startsWith('VENTS Wallet'))!.click(); });
    await pay();
    expect(pendingPurchaseCall()).toBeTruthy();
    expect(mockOpenPaystackPopup).not.toHaveBeenCalled();   // wallet chosen: no Paystack popup
  });

  it('"Someone else is paying" offers no wallet option anywhere (the duplicate used to)', async () => {
    await mount();
    await act(async () => { buttons().find((b) => (b.textContent || '').trim() === 'Someone else is paying')!.click(); });
    expect(buttons().some((b) => /VENTS Wallet/.test(b.textContent || ''))).toBe(false);
  });
});

describe('checkout: name and email required, phone optional', () => {
  it('labels the phone field as optional', async () => {
    await mount();
    expect(container!.textContent).toContain('Phone Number (Optional)');
    expect(container!.textContent).not.toContain('Phone Number *');
  });

  it('pays with no phone number: the order is created and the holder has no phone', async () => {
    await mount();
    await pay();
    const call = pendingPurchaseCall();
    expect(call, container!.textContent!.slice(0, 300)).toBeTruthy();
    expect(call![1].p_attendees).toEqual([{ name: 'Buyer Person', email: 'buyer@example.com', phone: undefined }]);
    expect(mockOpenPaystackPopup).toHaveBeenCalledTimes(1);
  });

  it('pays with a phone number: it is validated and saved in E.164', async () => {
    await mount();
    type(container!.querySelector<HTMLInputElement>('input[inputmode="tel"]'), '8012345678');
    await pay();
    expect(pendingPurchaseCall()![1].p_attendees[0].phone).toBe('+2348012345678');
  });

  it('an invalid phone number that was entered still blocks payment', async () => {
    await mount();
    type(container!.querySelector<HTMLInputElement>('input[inputmode="tel"]'), '12');
    await pay();
    expect(pendingPurchaseCall()).toBeUndefined();
    expect(container!.textContent).toContain('Enter a valid phone number, or leave it empty.');
  });

  it('full name is required', async () => {
    await mount();
    type(byPlaceholder('Your full name')[0], '   ');
    await pay();
    expect(pendingPurchaseCall()).toBeUndefined();
    expect(container!.textContent).toContain('Enter your full name.');
    expect(container!.textContent).toContain('Full name is required');
  });

  it('email must be valid (existing validation unchanged)', async () => {
    await mount();
    type(byPlaceholder('name@gmail.com')[0], 'not-an-email');
    await pay();
    expect(pendingPurchaseCall()).toBeUndefined();
    expect(container!.textContent).toContain('A valid email address is required to pay.');
  });
});

describe('checkout: additional attendees', () => {
  it('need a name and an email but no phone', async () => {
    await mount(2);
    expect(container!.textContent!.split('Phone Number (Optional)').length - 1).toBe(2);   // purchaser + attendee 2
    type(byPlaceholder('Attendee 2 full name')[0], 'Second Guest');
    type(byPlaceholder('name@gmail.com')[1], 'second@example.com');
    await pay();
    expect(pendingPurchaseCall()![1].p_attendees[1]).toEqual({ name: 'Second Guest', email: 'second@example.com', phone: undefined });
  });

  it('a missing attendee email still blocks payment', async () => {
    await mount(2);
    type(byPlaceholder('Attendee 2 full name')[0], 'Second Guest');
    await pay();
    expect(pendingPurchaseCall()).toBeUndefined();
    expect(container!.textContent).toContain('Enter a full name and email for all 2 attendees');
  });

  it('an attendee phone that is entered must be valid', async () => {
    await mount(2);
    type(byPlaceholder('Attendee 2 full name')[0], 'Second Guest');
    type(byPlaceholder('name@gmail.com')[1], 'second@example.com');
    type(byPlaceholder('080 0000 0000')[0], '12');
    await pay();
    expect(pendingPurchaseCall()).toBeUndefined();
    expect(container!.textContent).toContain('Enter a valid phone number');
  });
});
