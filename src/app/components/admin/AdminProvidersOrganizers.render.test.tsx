import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminProvidersList } from './AdminProvidersList';
import { AdminProviderDetail } from './AdminProviderDetail';
import { AdminOrganizersList } from './AdminOrganizersList';
import { AdminOrganizerDetail } from './AdminOrganizerDetail';

const providerData = {
  id: 'p1', user_id: 'u1', business_name: 'Glow Makeup Studio', category: 'Beauty',
  country: 'NG', status: 'approved', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const ownerData = { id: 'u1', username: 'glowstudio', full_name: 'Glow Studio', email: 'glow@x.com' };
const organizerData = {
  id: 'o1', full_name: 'Promoter Co', username: 'promoterco', email: 'promoter@x.com',
  phone_number: '08010000000', state: 'Lagos', is_verified: true, created_at: '2026-01-01T00:00:00Z',
  role: 'organizer',
};

vi.mock('../../../lib/serviceProviders', () => ({
  withProviderRatings: async (providers: any[]) => providers.map((p) => ({ ...p, avgRating: 4.5, reviewCount: 12 })),
}));
vi.mock('../../../lib/providerServices', () => ({
  fetchOwnServicesForProvider: async () => [{ id: 's1', providerId: 'p1', name: 'Bridal Makeup', price: 50000, currency: 'NGN', isActive: true, createdAt: '', updatedAt: '' }],
}));

vi.mock('../../../lib/supabase', () => {
  function makeQuery(resolveData: any[]) {
    let filtered = resolveData;
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (col: string, val: any) => { filtered = filtered.filter((r: any) => r[col] === val); return q; },
      neq: () => q,
      or: () => q,
      is: () => q,
      not: () => q,
      in: () => q,
      ilike: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: filtered, error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'service_providers') return makeQuery([providerData]);
        if (table === 'users') return makeQuery([ownerData, organizerData]);
        if (table === 'provider_services') return makeQuery([]);
        if (table === 'service_provider_requests') return makeQuery([]);
        if (table === 'organizer_verification_requests') return makeQuery([]);
        if (table === 'events') return makeQuery([]);
        if (table === 'organizer_withdrawal_requests') return makeQuery([]);
        if (table === 'organizer_wallets') return makeQuery([]);
        return makeQuery([]);
      },
      rpc: (name: string) => {
        if (name === 'admin_list_organizer_verifications') return Promise.resolve({ data: [], error: null });
        return Promise.resolve({ data: null, error: null });
      },
    },
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null; root = null;
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AdminProvidersList', () => {
  it('renders desktop table with real provider data', async () => {
    await act(async () => { root!.render(<AdminProvidersList isMobile={false} onSelectProvider={() => {}} />); });
    await flush();
    expect(container!.querySelector('[data-testid="admin-providers-list"]')!.textContent).toContain('Glow Makeup Studio');
    expect(container!.textContent).toContain('PROVIDER');
  });

  it('renders mobile card list instead of a table', async () => {
    await act(async () => { root!.render(<AdminProvidersList isMobile={true} onSelectProvider={() => {}} />); });
    await flush();
    expect(container!.textContent).not.toContain('PROVIDER');
    expect(container!.textContent).toContain('Glow Makeup Studio');
  });
});

describe('AdminProviderDetail', () => {
  it('renders real profile/rating data and flags bookings/earnings as not available', async () => {
    await act(async () => { root!.render(<AdminProviderDetail providerId="p1" isSuperAdmin={true} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-provider-detail"]')!;
    expect(el.textContent).toContain('Glow Makeup Studio');
    expect(el.textContent).toContain('4.5');
    const bookingsTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'Bookings') as HTMLElement;
    await act(async () => { bookingsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('Not available');
  });
});

describe('AdminOrganizersList', () => {
  it('renders desktop table with real organizer data', async () => {
    await act(async () => { root!.render(<AdminOrganizersList isMobile={false} onSelectOrganizer={() => {}} />); });
    await flush();
    expect(container!.textContent).toContain('Promoter Co');
    expect(container!.textContent).toContain('ORGANIZER');
  });

  it('renders mobile card list instead of a table', async () => {
    await act(async () => { root!.render(<AdminOrganizersList isMobile={true} onSelectOrganizer={() => {}} />); });
    await flush();
    expect(container!.textContent).not.toContain('ORGANIZER');
    expect(container!.textContent).toContain('Promoter Co');
  });
});

describe('AdminOrganizerDetail', () => {
  it('renders real profile data and flags KYC as not available with no verification request', async () => {
    await act(async () => { root!.render(<AdminOrganizerDetail organizerId="o1" isSuperAdmin={true} isMobile={false} onBack={() => {}} />); });
    await flush();
    const el = container!.querySelector('[data-testid="admin-organizer-detail"]')!;
    expect(el.textContent).toContain('Promoter Co');
    const kycTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'KYC') as HTMLElement;
    await act(async () => { kycTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(el.textContent).toContain('Not available');
  });
});
