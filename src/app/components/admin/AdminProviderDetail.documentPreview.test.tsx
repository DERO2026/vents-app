import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminProviderDetail } from './AdminProviderDetail';

// Regression coverage for a confirmed bug: the Overview tab's "Provider
// Application (KYC)" card printed service_provider_requests.document_url
// as raw, unlinked text ("Document on file: <path>") instead of a
// clickable preview. The path is a private-bucket storage key, not a
// public URL, so an admin had no way to actually open the document from
// this screen -- unlike AdminProviderRequestsScreen's equivalent queue,
// which already previews the same field via a signed URL.

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
const requestRow = {
  id: 'r1', status: 'pending', provider_type: 'individual', business_name: 'Glow Makeup Studio',
  country: 'NG', document_url: 'verification-docs/u1/id.pdf', admin_note: null, reviewed_at: null,
  created_at: '2026-01-05T00:00:00Z',
};

const createSignedUrl = vi.fn((_bucket: string, _key: string, _expiry: number) => Promise.resolve({ data: { signedUrl: 'https://signed.example/id.pdf' }, error: null }));
const windowOpen = vi.fn();

vi.mock('../../../lib/supabase', () => {
  function makeQuery(resolveData: any[]) {
    const q: any = {
      select: () => q,
      order: () => q,
      eq: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: resolveData[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: resolveData, error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'service_providers') return makeQuery([providerData]);
        if (table === 'users') return makeQuery([ownerData]);
        if (table === 'service_provider_requests') return makeQuery([requestRow]);
        return makeQuery([]);
      },
      storage: {
        from: (bucket: string) => ({
          createSignedUrl: (key: string, expiry: number) => createSignedUrl(bucket, key, expiry),
        }),
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  createSignedUrl.mockClear();
  windowOpen.mockClear();
  vi.stubGlobal('open', windowOpen);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('AdminProviderDetail: KYC document preview', () => {
  it('shows a preview button (not a raw path) for the uploaded document and opens a signed URL on click', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminProviderDetail providerId="p1" isSuperAdmin={true} isMobile={false} onBack={() => {}} />); });
    await flush();

    const el = container.querySelector('[data-testid="admin-provider-detail"]')!;
    expect(el.textContent).not.toContain('Document on file:');
    expect(el.textContent).not.toContain('verification-docs/u1/id.pdf');

    const previewBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Preview uploaded document'));
    expect(previewBtn).toBeTruthy();

    await act(async () => { previewBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(createSignedUrl).toHaveBeenCalledWith('verification-docs', 'u1/id.pdf', 60);
    expect(windowOpen).toHaveBeenCalledWith('https://signed.example/id.pdf', '_blank', 'noopener,noreferrer');
  });
});
