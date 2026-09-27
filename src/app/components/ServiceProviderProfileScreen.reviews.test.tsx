import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderProfileScreen } from './ServiceProviderProfileScreen';
import type { ServiceProvider, ProviderService } from './types';

// Regression test for Provider Reviews requirement #7/#8: the Reviews tab
// must show real written review text (not just the aggregate rating), and
// never fabricate one when there is none.

const fetchProviderReviews = vi.fn();
vi.mock('../../lib/serviceBookings', () => ({
  createServiceBooking: vi.fn(),
  verifyServiceBookingPayment: vi.fn(),
  logServiceMarketplaceEvent: vi.fn(),
  fetchProviderReviews: (...args: any[]) => fetchProviderReviews(...args),
}));

vi.mock('../../lib/userWallet', () => ({
  fetchMyWalletBalanceKobo: vi.fn(async () => 100_000_00),
  payServiceBookingWithWallet: vi.fn(),
}));
vi.mock('../../lib/paystack', () => ({ openPaystackPopup: vi.fn() }));
vi.mock('../../lib/serviceProviders', () => ({
  fetchServiceProviderById: vi.fn(async () => null),
  withProviderRatings: vi.fn(async (rows: any[]) => rows),
}));
vi.mock('../../lib/serviceProviderCategories', () => ({
  fetchServiceProviderCategories: vi.fn(async () => []),
}));
vi.mock('../../lib/providerServices', () => ({
  fetchActiveServicesForProvider: vi.fn(async () => []),
}));

const provider: ServiceProvider & { avgRating?: number; reviewCount?: number } = {
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
  avgRating: 4.5,
  reviewCount: 2,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchProviderReviews.mockReset();
});

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ServiceProviderProfileScreen
        providerId="prov-1"
        initialProvider={provider as ServiceProvider}
        onBack={() => {}}
        currentUserId="user-1"
        currentUserEmail="user@example.com"
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function goToReviewsTab() {
  const tab = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Reviews');
  act(() => { tab!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('ServiceProviderProfileScreen: real written reviews', () => {
  it('displays real review text and reviewer name fetched from provider_reviews', async () => {
    fetchProviderReviews.mockResolvedValueOnce([
      { id: 'r1', rating: 5, body: 'Absolutely wonderful experience, will book again.', createdAt: '2026-01-02T00:00:00Z', reviewerName: 'Amaka O.' },
      { id: 'r2', rating: 4, body: 'Good service overall, slightly late.', createdAt: '2026-01-01T00:00:00Z', reviewerName: 'Tunde B.' },
    ]);
    await renderScreen();
    goToReviewsTab();
    await act(async () => { await Promise.resolve(); });

    expect(container!.textContent).toContain('Absolutely wonderful experience, will book again.');
    expect(container!.textContent).toContain('Amaka O.');
    expect(container!.textContent).toContain('Good service overall, slightly late.');
  });

  it('never fabricates review text when there are none, showing only the honest empty state', async () => {
    fetchProviderReviews.mockResolvedValueOnce([]);
    await renderScreen();
    goToReviewsTab();
    await act(async () => { await Promise.resolve(); });

    expect(container!.textContent).not.toContain('fabricated');
    // The honest aggregate copy is shown when reviewCount is falsy; here we
    // gave a non-zero reviewCount via the aggregate but zero real review
    // rows -- the written-reviews list itself must simply be absent.
    expect(container!.querySelectorAll('[data-review-card]').length).toBe(0);
  });
});
