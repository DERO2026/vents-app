import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminPayoutsScreen } from './AdminPayoutsScreen';

// "Check payout exceptions" (2026-07 incident): report-only. It posts
// mode 'exceptions' to reconcile-payouts, shows what Paystack says about
// requests VENTS shows as cancelled/failed/rejected, and changes nothing.

const fetchCalls: { url: string; body: any }[] = [];
let fetchResponses: Record<string, any> = {};

const PENDING_REQUEST = {
  id: 'req-1', organizer_id: 'org-1', amount_kobo: 500000, status: 'pending',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', admin_note: null,
  organizer_bank_accounts: { bank_name: 'Test Bank', account_number: '0001112222', account_name: 'Org One', recipient_code: 'RCP_x' },
  'users!organizer_withdrawal_requests_organizer_id_public_users_fkey': { username: 'orgone', full_name: 'Org One', email: 'org@example.com', phone_number: null },
};

// The default statusFilter is 'pending', which load() serves via the
// admin_list_pending_payouts RPC (not a direct .from('organizer_withdrawal_
// requests') select) -- already in the "normalized" request_id shape
// (the 'request_id' in r branch in AdminPayoutsScreen.tsx's load()).
const PENDING_RPC_ROW = {
  request_id: 'req-1', organizer_id: 'org-1', organizer_name: 'Org One', organizer_email: 'org@example.com',
  organizer_phone: null, amount_kobo: 500000, bank_name: 'Test Bank', account_number: '0001112222',
  account_name: 'Org One', recipient_code: 'RCP_x', status: 'pending', created_at: '2026-01-01T00:00:00Z',
};

vi.mock('../../../lib/supabase', () => {
  function makeQuery(resolveData: any[]) {
    const q: any = {
      select: () => q,
      order: () => q,
      eq: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      in: () => q,
      then: (resolve: any) => resolve({ data: resolveData, error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'organizer_withdrawal_requests') return makeQuery([PENDING_REQUEST]);
        if (table === 'app_config') return makeQuery([]);
        return makeQuery([]);
      },
      rpc: (name: string) => {
        if (name === 'admin_list_pending_payouts') return Promise.resolve({ data: [PENDING_RPC_ROW], error: null });
        return Promise.resolve({ data: [], error: null });
      },
      auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }) },
    },
  };
});

vi.mock('../../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('./adminAuditLog', () => ({ notifyByEmail: () => {} }));
vi.mock('../../../lib/withTimeoutFallback', () => ({ withTimeoutFallback: (p: Promise<any>) => p }));
vi.mock('../../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

const REPORT = {
  mode: 'exceptions', checked: 1, deferred_count: 0, changed: 0,
  report: [{ request_id: '3aa0f8ff-d652-48cb-a06f-82a99d434dbe', request_status: 'cancelled', amount_kobo: 10000,
             exception_kind: 'transfer_code_on_cancelled_request', paystack_status: 'success', finding: 'paid_not_recorded' }],
};
vi.stubGlobal('fetch', vi.fn((url: string, opts: any) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  fetchCalls.push({ url, body });
  return Promise.resolve({ ok: true, json: async () => (body.mode === 'exceptions' ? REPORT : {}) });
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { fetchCalls.length = 0; container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { act(() => root?.unmount()); container.remove(); vi.clearAllMocks(); });
async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }

describe('AdminPayoutsScreen: payout exceptions check', () => {
  it('posts mode=exceptions, shows the paid-but-cancelled transfer, and sends nothing else', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminPayoutsScreen />); });
    await flush();
    const btn = container.querySelector('[data-testid="payout-exceptions-check"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(fetchCalls).toEqual([{ url: '/api/v1/wallet/reconcile-payouts', body: { mode: 'exceptions' } }]);
    const report = container.querySelector('[data-testid="payout-exceptions-report"]')!;
    expect(report.textContent).toContain('nothing was changed');
    const row = container.querySelector('[data-testid="payout-exception-3aa0f8ff-d652-48cb-a06f-82a99d434dbe"]')!;
    expect(row.textContent).toContain('Paid by Paystack, not recorded in VENTS');
    expect(row.textContent).toContain('VENTS status cancelled');
    expect(row.textContent).toContain('Paystack success');
    expect(report.textContent).toContain('Resolve with two admins');
  });
});
