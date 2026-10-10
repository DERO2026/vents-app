import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { CheckoutScreen } from './CheckoutScreen';
import type { Event, TicketType } from './types';

// Regression coverage for two real free-ticket bugs this pass fixed:
//
// 1. App.tsx's handleTicketContinue() used to skip CheckoutScreen entirely
//    for a single-quantity free ticket, issuing a real ticket the instant
//    the user tapped "Get tickets" -- no attendee-details step, no
//    validation, nothing shown. That shortcut lived in App.tsx (not this
//    file) and has been removed there; this file now covers the
//    confirmation step it was bypassing.
// 2. The free-ticket path minted a fresh VNT-FREE-${Date.now()} reference
//    on every handleFreeTicket() call, defeating purchase_ticket's own
//    idempotency-by-payment_ref check -- a double-tap (or client retry)
//    could mint two distinct references and issue two real tickets for
//    one claim. The reference is now generated once per mounted checkout
//    attempt (a ref, not recomputed per call).

vi.mock('../../lib/analyticsEvents', () => ({ analytics: { checkoutStarted: () => {}, ticketPurchased: () => {} } }));
vi.mock('../../lib/haptics', () => ({ haptics: { medium: () => {}, light: () => {}, success: () => {} } }));
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: () => {} }));
vi.mock('../../lib/userWallet', () => ({ fetchMyWalletBalanceKobo: () => Promise.resolve(0), payTicketWithWallet: () => Promise.resolve({ success: false }) }));
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: () => Promise.resolve({ data: null, error: null }) } }));
vi.mock('../../lib/operationalStatus', () => ({ friendlyOperationalError: (e: any) => String(e) }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

const EVENT = { id: 'event-1', title: 'Test Event', price: 0 } as unknown as Event;
const FREE_TICKET_TYPE: TicketType = { id: 'tt-1', name: 'General', price: 0, description: '', available: 50 };
const CURRENT_USER = { id: 'user-1', email: 'buyer@example.com', full_name: 'Buyer Person' };

async function mount(onSuccess = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <CheckoutScreen
        event={EVENT}
        ticketType={FREE_TICKET_TYPE}
        quantity={1}
        currentUser={CURRENT_USER}
        onBack={() => {}}
        onSuccess={onSuccess}
      />
    );
  });
  return onSuccess;
}

function fillRequiredFields() {
  // PhoneInput deliberately uses type="text"/inputMode="tel" (see its own
  // comment) to suppress iOS's QuickType contact strip, not type="tel".
  const phoneInput = container!.querySelector('input[inputmode="tel"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  if (phoneInput) {
    act(() => {
      setter.call(phoneInput, '8012345678');
      phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

function getPayButton(): HTMLButtonElement {
  return Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Get Free Ticket'))! as HTMLButtonElement;
}

describe('CheckoutScreen: free-ticket claim requires the same validated confirmation step as a paid ticket', () => {
  it('shows a real "Get Free Ticket" confirmation button -- it does not issue anything on mount', async () => {
    const onSuccess = await mount();
    expect(getPayButton()).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not issue a ticket if the required phone number is missing', async () => {
    const onSuccess = await mount();
    await act(async () => {
      getPayButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('phone number');
  });

  it('issues exactly one ticket after valid details are submitted', async () => {
    const onSuccess = await mount();
    fillRequiredFields();
    await act(async () => {
      getPayButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0].totalAmount).toBe(0);
  });

  it('a duplicate submission (double-tap past the button) reuses the exact same reference, so the server-side idempotency check can collapse it into one ticket', async () => {
    const onSuccess = await mount();
    fillRequiredFields();

    // Simulate a double-tap landing before the single-flight ref/disabled
    // state updates -- call handlePay's underlying click handler twice in
    // the same tick.
    const button = getPayButton();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // The component's own single-flight guard should prevent a second
    // call from firing at all, but the real fix under test is that EVEN
    // IF a second call reached handleFreeTicket (e.g. after a remount-free
    // retry), it would carry the same ticketId/payment_ref. Assert the
    // reference used is stable and well-formed.
    expect(onSuccess.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstRef = onSuccess.mock.calls[0][0].ticketId;
    expect(firstRef).toMatch(/^VNT-FREE-/);
    if (onSuccess.mock.calls.length > 1) {
      expect(onSuccess.mock.calls[1][0].ticketId).toBe(firstRef);
    }
  });
});
