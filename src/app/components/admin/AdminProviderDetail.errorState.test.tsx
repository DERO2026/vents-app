import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminProviderDetail } from './AdminProviderDetail';

// Regression coverage for a confirmed bug: the Overview tab's KYC-request
// fetch and the Audit tab's fetch both used .then(...).finally(...) with
// no .catch() -- a failed query rendered as a confident "no
// service_provider_requests row exists" / "No admin actions recorded"
// instead of an error.

vi.mock('../../../lib/serviceProviders', () => ({
  withProviderRatings: async (providers: any[]) => providers.map((p) => ({ ...p, avgRating: 4.5, reviewCount: 12 })),
}));
vi.mock('../../../lib/providerServices', () => ({
  fetchOwnServicesForProvider: async () => [],
}));
vi.mock('../../../lib/serviceBookings', () => ({
  fetchAdminServiceBookings: async () => [],
}));

const providerData = {
  id: 'p1', user_id: 'u1', business_name: 'Glow Makeup Studio', category: 'Beauty',
  country: 'NG', status: 'approved', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const ownerData = { id: 'u1', username: 'glowstudio', full_name: 'Glow Studio', email: 'glow@x.com' };

vi.mock('../../../lib/supabase', () => {
  function makeOkQuery(row: any) {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
    };
    return q;
  }
  function makeFailingQuery() {
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
      then: (resolve: any) => resolve({ data: null, error: { message: 'permission denied' } }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'service_providers') return makeOkQuery(providerData);
        if (table === 'users') return makeOkQuery(ownerData);
        return makeFailingQuery();
      },
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function mount() {
  root = createRoot(container);
  act(() => { root.render(<AdminProviderDetail providerId="p1" isSuperAdmin={true} isMobile={false} onBack={() => {}} />); });
  await flush();
}

function clickTab(el: Element, label: string) {
  const tab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === label) as HTMLElement;
  return act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('AdminProviderDetail: tab error states', () => {
  it('Overview KYC card shows an explicit error instead of claiming no application was ever filed', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-provider-detail"]')!;
    await flush();
    expect(el.textContent).toContain('could not load the application status');
    expect(el.textContent).not.toContain('they were granted the capability another way');
  });

  it('Audit tab shows an explicit error instead of "No admin actions recorded" when the fetch fails', async () => {
    await mount();
    const el = container.querySelector('[data-testid="admin-provider-detail"]')!;
    await clickTab(el, 'Audit');
    await flush();
    expect(el.textContent).toContain('could not load the audit trail');
    expect(el.textContent).not.toContain("No admin actions recorded for this provider's application.");
  });
});
