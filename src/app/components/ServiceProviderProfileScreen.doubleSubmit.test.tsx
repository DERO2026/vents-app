import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderProfileScreen } from './ServiceProviderProfileScreen';
import type { ServiceProvider, ProviderService } from './types';

// Regression tests for audit issue #3: handleBookAndPay relied only on the
// `booking` React state to guard against re-entrancy, which doesn't become
// true until the next render -- a rapid mobile double-tap could invoke it
// twice before that commits. Fixed with a synchronous `bookingRef`, the same
// pattern CheckoutScreen.tsx already uses (`payingRef`) for ticket purchase.

const createServiceBooking = vi.fn();
const verifyServiceBookingPayment = vi.fn();
const logServiceMarketplaceEvent = vi.fn();
vi.mock('../../lib/serviceBookings', () => ({
  createServiceBooking: (...args: any[]) => createServiceBooking(...args),
  verifyServiceBookingPayment: (...args: any[]) => verifyServiceBookingPayment(...args),
  logServiceMarketplaceEvent: (...args: any[]) => logServiceMarketplaceEvent(...args),
}));

const payServiceBookingWithWallet = vi.fn();
const fetchMyWalletBalanceKobo = vi.fn(async () => 100_000_00); // plenty
vi.mock('../../lib/userWallet', () => ({
  fetchMyWalletBalanceKobo: () => fetchMyWalletBalanceKobo(),
  payServiceBookingWithWallet: (...args: any[]) => payServiceBookingWithWallet(...args),
}));

vi.mock('../../lib/paystack', () => ({ openPaystackPopup: vi.fn() }));
vi.mock('../../lib/serviceProviders', () => ({
  fetchServiceProviderById: vi.fn(async () => null),
  withProviderRatings: vi.fn(async (rows: any[]) => rows),
}));
vi.mock('../../lib/serviceProviderCategories', () => ({
  fetchServiceProviderCategories: vi.fn(async () => []),
}));

const service: ProviderService = {
  id: 'svc-1',
  providerId: 'prov-1',
  name: 'Photography',
  price: 50000,
  currency: 'NGN',
  isActive: true,
  createdAt: '',
  updatedAt: '',
};
vi.mock('../../lib/providerServices', () => ({
  fetchActiveServicesForProvider: vi.fn(async () => [service]),
}));

const provider: ServiceProvider = {
  id: 'prov-1',
  userId: 'owner-1',
  businessName: 'Glow Studio',
  category: 'Photography',
  country: 'NG',
  photoUrls: [],
  servicesOffered: [],
  offersHomeService: false,
  offersDelivery: false,
  offersSameDay: false,
  status: 'approved' as ServiceProvider['status'],
  createdAt: '',
  updatedAt: '',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  createServiceBooking.mockReset();
  verifyServiceBookingPayment.mockReset();
  payServiceBookingWithWallet.mockReset();
});

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ServiceProviderProfileScreen
        providerId="prov-1"
        initialProvider={provider}
        onBack={() => {}}
        currentUserId="user-1"
        currentUserEmail="user@example.com"
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectServiceAndWalletMethod() {
  // Select the one listed service (toggles it into the booking cart) by
  // clicking its name <p> -- the click bubbles up to the card div's
  // onClick, same as a real tap anywhere on the card.
  const serviceName = Array.from(container!.querySelectorAll('p')).find((p) => p.textContent === 'Photography');
  act(() => { serviceName!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  // Switch to VENTS Wallet so the flow resolves without a Paystack popup.
  const walletButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('VENTS Wallet'));
  act(() => { walletButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function getBookButton() {
  return Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Book & Pay') || b.textContent === 'Processing…')!;
}

describe('ServiceProviderProfileScreen: handleBookAndPay re-entrancy guard', () => {
  it('a rapid double-tap only creates ONE booking attempt', async () => {
    await renderScreen();
    await selectServiceAndWalletMethod();

    let resolveCreate: (v: any) => void = () => {};
    createServiceBooking.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve; }));

    const bookButton = getBookButton();
    // Two rapid taps, both dispatched before any awaited work resolves --
    // simulates the mobile double-tap window this guard closes.
    act(() => {
      bookButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      bookButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(createServiceBooking).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate({ paymentRef: 'ref-1', bookingId: 'booking-1', totalKobo: 5250000 });
      payServiceBookingWithWallet.mockResolvedValueOnce({ status: 'success' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(payServiceBookingWithWallet).toHaveBeenCalledTimes(1);
  });

  it('the guard resets after a failure so a legitimate retry works', async () => {
    await renderScreen();
    await selectServiceAndWalletMethod();

    createServiceBooking.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      getBookButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('network down');

    createServiceBooking.mockResolvedValueOnce({ paymentRef: 'ref-2', bookingId: 'booking-2', totalKobo: 5250000 });
    payServiceBookingWithWallet.mockResolvedValueOnce({ status: 'success' });

    await act(async () => {
      getBookButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createServiceBooking).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain('Photography');
  });

  it('the guard resets after success, and a further tap is a no-op only because the button is gone/disabled, not because the ref is stuck', async () => {
    await renderScreen();
    await selectServiceAndWalletMethod();

    createServiceBooking.mockResolvedValueOnce({ paymentRef: 'ref-3', bookingId: 'booking-3', totalKobo: 5250000 });
    payServiceBookingWithWallet.mockResolvedValueOnce({ status: 'success' });

    await act(async () => {
      getBookButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createServiceBooking).toHaveBeenCalledTimes(1);
    expect(payServiceBookingWithWallet).toHaveBeenCalledTimes(1);
  });
});
