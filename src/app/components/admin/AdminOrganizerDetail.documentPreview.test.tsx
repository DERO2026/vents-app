import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminOrganizerDetail } from './AdminOrganizerDetail';

// Regression coverage for a confirmed bug: the KYC tab fetched
// organizer_verification_requests.document_url into state but never
// rendered anything for it -- an admin could click Approve/Reject on a
// CAC verification from this per-organizer detail screen with no way to
// actually see the submitted document. AdminVerificationScreen's
// equivalent queue already had a working preview button (a signed URL
// from the private verification-docs bucket); this proves the same
// pattern now exists here too.

const organizerData = {
  id: 'o1', full_name: 'Promoter Co', username: 'promoterco', email: 'promoter@x.com',
  phone_number: '08010000000', state: 'Lagos', is_verified: true, created_at: '2026-01-01T00:00:00Z',
};
const verifRow = {
  id: 'v1', status: 'pending', company_name: 'Promoter Co Ltd', cac_number: 'RC123456',
  owner_name: 'Jane Promoter', registration_date: '2025-01-01', business_email: 'biz@x.com',
  business_phone: '0800000000', business_address: '1 Lagos Way', document_url: 'verification-docs/o1/cac.pdf',
  admin_note: null, created_at: '2026-01-05T00:00:00Z', reviewed_at: null,
};

const createSignedUrl = vi.fn((_bucket: string, _key: string, _expiry: number) => Promise.resolve({ data: { signedUrl: 'https://signed.example/cac.pdf' }, error: null }));
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
        if (table === 'users') return makeQuery([organizerData]);
        if (table === 'organizer_verification_requests') return makeQuery([verifRow]);
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

describe('AdminOrganizerDetail: KYC document preview', () => {
  it('shows a preview button for the uploaded CAC document and opens a signed URL on click', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminOrganizerDetail organizerId="o1" isSuperAdmin={true} isMobile={false} onBack={() => {}} />); });
    await flush();

    const el = container.querySelector('[data-testid="admin-organizer-detail"]')!;
    const kycTab = Array.from(el.querySelectorAll('div')).find((d) => d.textContent === 'KYC') as HTMLElement;
    await act(async () => { kycTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const previewBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Preview uploaded CAC document'));
    expect(previewBtn).toBeTruthy();

    await act(async () => { previewBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(createSignedUrl).toHaveBeenCalledWith('verification-docs', 'o1/cac.pdf', 60);
    expect(windowOpen).toHaveBeenCalledWith('https://signed.example/cac.pdf', '_blank', 'noopener,noreferrer');
  });
});
