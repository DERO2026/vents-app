import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderProfileScreen } from './ServiceProviderProfileScreen';
import type { ServiceProvider } from './types';

// Regression test for the QA-audit "bottom content hidden under the sticky
// CTA bar" bug: the scroll content used a hardcoded 110px bottom padding,
// but the CTA bar's real height varies a lot (idle "Book this provider" vs.
// a stacked success/error banner + selection summary + date/time inputs +
// payment method row + Book & Pay + Contact Provider once services are
// selected) and can exceed 110px, clipping content underneath it. The
// content pane must instead size its padding from the CTA bar's actual
// measured height.

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
vi.mock('../../lib/serviceProviders', () => ({
  fetchServiceProviderById: vi.fn(async () => ({
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
    status: 'approved',
    createdAt: '',
    updatedAt: '',
  })),
  withProviderRatings: vi.fn(async (rows: any[]) => rows),
}));
vi.mock('../../lib/serviceProviderCategories', () => ({
  fetchServiceProviderCategories: vi.fn(async () => []),
}));
vi.mock('../../lib/providerServices', () => ({
  fetchActiveServicesForProvider: vi.fn(async () => []),
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
});

describe('ServiceProviderProfileScreen: sticky CTA bar never hides content', () => {
  it('sizes the scroll content bottom padding from the CTA bar itself, not a hardcoded guess', async () => {
    // jsdom has no real layout engine, so the CTA bar's measured
    // offsetHeight is 0 there; the component must fall back to a sane
    // default padding in that case rather than collapsing to 0.
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

    const content = container!.querySelector('.sp-profile-content') as HTMLDivElement;
    expect(content).toBeTruthy();
    // Must reference the measured bar height (a CSS calc()), never a bare
    // hardcoded pixel value with no relation to the actual bar.
    expect(content.style.paddingBottom).toMatch(/^calc\(/);
  });
});
