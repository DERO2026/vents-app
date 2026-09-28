import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderProfileScreen } from './ServiceProviderProfileScreen';
import type { ServiceProvider } from './types';

// Regression test for the QA-audit "provider profile must show CURRENT
// saved data" bug: the screen used to skip its fresh fetchServiceProviderById
// call entirely whenever an initialProvider with a matching id was passed
// in, so a stale rating/business-name snapshot from a list screen would be
// shown forever, never refreshed. It must now always refetch on mount and
// let the fresh result (including the real service_provider_ratings
// aggregate via withProviderRatings) win.

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

const staleProvider: ServiceProvider & { avgRating?: number; reviewCount?: number } = {
  id: 'prov-1',
  userId: 'owner-1',
  businessName: 'Stale Business Name',
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
  avgRating: 2.0,
  reviewCount: 1,
};

const freshProvider: ServiceProvider = {
  ...staleProvider,
  businessName: 'Fresh Business Name',
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

describe('ServiceProviderProfileScreen: no stale cached provider data', () => {
  it('always refetches on mount and replaces a stale initialProvider snapshot with the fresh result', async () => {
    fetchServiceProviderById.mockResolvedValue(freshProvider);
    withProviderRatings.mockImplementation(async (rows: any[]) => rows.map((r) => ({ ...r, avgRating: 4.9, reviewCount: 40 })));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ServiceProviderProfileScreen
          providerId="prov-1"
          initialProvider={staleProvider}
          onBack={() => {}}
          currentUserId="user-1"
          currentUserEmail="user@example.com"
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchServiceProviderById).toHaveBeenCalledWith('prov-1');
    expect(withProviderRatings).toHaveBeenCalled();
    expect(container!.textContent).toContain('Fresh Business Name');
    expect(container!.textContent).not.toContain('Stale Business Name');
    // The real aggregate rating, never the stale/fabricated one.
    expect(container!.textContent).toContain('4.9');
    expect(container!.textContent).toContain('40');
  });

  it('keeps showing the initialProvider placeholder (never a blank/not-found screen) on a transient refetch failure', async () => {
    fetchServiceProviderById.mockRejectedValue(new Error('network down'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ServiceProviderProfileScreen
          providerId="prov-1"
          initialProvider={staleProvider}
          onBack={() => {}}
          currentUserId="user-1"
          currentUserEmail="user@example.com"
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('Stale Business Name');
    expect(container!.textContent).not.toContain("isn't available right now");
  });
});
