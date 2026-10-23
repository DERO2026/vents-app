import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { CheckoutScreen } from './CheckoutScreen';
import type { Event, TicketType } from './types';

// Regression coverage for the bug /verify caught in commit 317e825:
// CheckoutScreen's real paid-ticket openPaystackPopup() call hardcoded
// channels: ['card', 'bank_transfer', 'ussd', 'mobile_money', 'bank'],
// which — because openPaystackPopup() is `channels: opts.channels ||
// defaultChannels()` — silently overrode the wallet-aware default on the
// one screen that actually matters for Google Pay/Apple Pay. The fix is
// omitting `channels` entirely here so it falls through to
// src/lib/paystack.ts's own defaultChannels(), which is what this test
// asserts directly against the real openPaystackPopup call this screen
// makes — not against paystack.ts in isolation (that's covered by
// src/lib/paystack.test.ts already).

const mockOpenPaystackPopup = vi.fn();
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: (opts: any) => mockOpenPaystackPopup(opts) }));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { checkoutStarted: () => {}, ticketPurchased: () => {} } }));
vi.mock('../../lib/haptics', () => ({ haptics: { medium: () => {}, light: () => {}, success: () => {} } }));
vi.mock('../../lib/userWallet', () => ({ fetchMyWalletBalanceKobo: () => Promise.resolve(0), payTicketWithWallet: () => Promise.resolve({ status: 'error', error: 'not used in this test' }) }));
vi.mock('../../lib/operationalStatus', () => ({ friendlyOperationalError: (e: any) => String(e) }));

const mockRpc = vi.fn();
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: (name: string, args: any) => mockRpc(name, args) } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  mockOpenPaystackPopup.mockReset();
  mockRpc.mockReset();
  mockRpc.mockImplementation((name: string) => {
    if (name === 'create_pending_purchase') {
      return Promise.resolve({ data: { payment_ref: 'vnt_order_1', amount_kobo: 525000 }, error: null });
    }
    if (name === 'initiate_ticket_payment_attempt') {
      return Promise.resolve({ data: { reference: 'vnt_attempt_1', amount_kobo: 525000 }, error: null });
    }
    if (name === 'get_my_wallet') {
      return Promise.resolve({ data: [{ balance_kobo: 0 }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

const EVENT = { id: 'event-1', title: 'Test Event', image: '', price: 5000 } as unknown as Event;
const PAID_TICKET_TYPE: TicketType = { id: 'tt-1', name: 'Regular', price: 5000, description: '', available: 50 };
const CURRENT_USER = { id: 'user-1', email: 'buyer@example.com', full_name: 'Buyer Person' };

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <CheckoutScreen
        event={EVENT}
        ticketType={PAID_TICKET_TYPE}
        quantity={1}
        currentUser={CURRENT_USER}
        onBack={() => {}}
        onSuccess={() => {}}
      />
    );
  });
}

function fillRequiredFields() {
  const phoneInput = container!.querySelector('input[inputmode="tel"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(phoneInput, '8012345678');
    phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function getPayButton(): HTMLButtonElement {
  // Not a plain .includes('Pay') match -- the "Card / Bank (Paystack)"
  // payment-method toggle button also contains the substring "Pay" (inside
  // "Paystack"), and sits earlier in the DOM than the real submit button.
  return Array.from(container!.querySelectorAll('button')).find((b) => /^Pay ₦/.test(b.textContent || ''))! as HTMLButtonElement;
}

async function driveToPaystackCall() {
  await mount();
  fillRequiredFields();
  await act(async () => {
    getPayButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // handlePay is async (two awaited RPC round-trips before
    // openPaystackPopup is called) -- flush microtasks enough times for
    // both to resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CheckoutScreen real paid-ticket checkout: Paystack channels', () => {
  it('calls openPaystackPopup for a real paid ticket purchase', async () => {
    await driveToPaystackCall();
    expect(mockOpenPaystackPopup).toHaveBeenCalledTimes(1);
  });

  it('does NOT pass a channels override -- lets openPaystackPopup fall through to its own wallet-aware defaultChannels()', async () => {
    await driveToPaystackCall();
    const call = mockOpenPaystackPopup.mock.calls[0][0];
    expect(call.channels).toBeUndefined();
  });

  it('still passes every other field the real Paystack charge needs (amount, ref, email) -- the fix only removed channels', async () => {
    await driveToPaystackCall();
    const call = mockOpenPaystackPopup.mock.calls[0][0];
    expect(call.amountKobo).toBe(525000);
    expect(call.ref).toBe('vnt_attempt_1');
    expect(call.email).toBe('buyer@example.com');
  });
});
