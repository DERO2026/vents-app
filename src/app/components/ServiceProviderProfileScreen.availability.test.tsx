import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderProfileScreen } from './ServiceProviderProfileScreen';
import type { ServiceProvider } from './types';

// Batch 2.1: the approved prototype's "Availability" section (About tab)
// -- static, honest copy explaining the real request -> provider-confirms
// booking flow, since this app has no calendar. Always shown, since it's
// true for every provider, not provider-supplied data that could be
// missing or fabricated.

const fetchServiceProviderById = vi.fn();
const withProviderRatings = vi.fn();
vi.mock('../../lib/serviceProviders', () => ({
  fetchServiceProviderById: (...args: any[]) => fetchServiceProviderById(...args),
  withProviderRatings: (...args: any[]) => withProviderRatings(...args),
}));
vi.mock('../../lib/serviceBookings', () => ({
  createServiceBooking: vi.fn(),
  verifyServiceBookingPayment: vi.fn(),
  logServiceMarketplaceEvent: vi.fn(),
  fetchProviderReviews: vi.fn(async () => []),
}));
vi.mock('../../lib/userWallet', () => ({
  fetchMyWalletBalanceKobo: vi.fn(async () => 0),
  payServiceBookingWithWallet: vi.fn(),
}));
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: vi.fn() }));
vi.mock('../../lib/serviceProviderCategories', () => ({
  fetchServiceProviderCategories: vi.fn(async () => []),
}));
vi.mock('../../lib/providerServices', () => ({
  fetchActiveServicesForProvider: vi.fn(async () => []),
}));

const provider: ServiceProvider & { avgRating?: number; reviewCount?: number } = {
  id: 'prov-1',
  userId: 'owner-1',
  businessName: 'Real Provider',
  category: 'Photography & Videography',
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
  fetchServiceProviderById.mockReset();
  withProviderRatings.mockReset();
});

describe('ServiceProviderProfileScreen: Availability section (About tab)', () => {
  it('shows the honest "calendars aren\'t shown" copy, not a fabricated calendar or availability data', async () => {
    fetchServiceProviderById.mockResolvedValue(provider);
    withProviderRatings.mockImplementation(async (rows: any[]) => rows);

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
      await Promise.resolve();
    });

    const aboutTab = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'About')!;
    act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container!.textContent).toContain('Availability');
    expect(container!.textContent).toContain("Calendars aren't shown.");
    expect(container!.textContent).toContain('provider confirms your date');
  });
});
