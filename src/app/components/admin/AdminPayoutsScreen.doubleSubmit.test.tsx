import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminPayoutsScreen } from './AdminPayoutsScreen';

// Regression coverage for two confirmed bugs in this screen:
//
// 1. "Approve & Pay" -- the one action here that actually moves real money
//    via Paystack -- fired directly on button click with NO confirmation
//    step at all, unlike Reject/Cancel (both typed-confirmation). Now
//    gated behind a ConfirmModal, matching the other two actions.
// 2. actionLoading (a React state value) was the only double-click guard
//    on Approve/Reject/Cancel. A fast double-click on a button -- or,
//    worse, on ConfirmModal's own Confirm button, which has no busy state
//    of its own -- can fire the handler twice before React's state update
//    actually disables anything. A new synchronous actionInFlightRef
//    closes that race for all three actions, the same pattern used for
//    AdminVCScreen's credit/debit (AdminVCScreen.doubleSubmit.test.tsx).
//    This matters most for Reject/Cancel specifically: unlike Approve
//    (protected server-side by admin_claim_payout_for_processing's atomic
//    compare-and-swap, confirmed live), admin_reject_organizer_payout and
//    admin_cancel_processing_payout both have a confirmed server-side
//    TOCTOU race (fix prepared in supabase/migrations/0187_fix_payout_
//    reject_cancel_toctou_race.sql, NOT applied) -- so the client-side
//    ref here is the only mitigation in place until that migration lands.

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
      in: () => Promise.resolve({ data: [], error: null }),
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

vi.stubGlobal('fetch', vi.fn((url: string, opts: any) => {
  const body = opts?.body ? JSON.parse(opts.body) : {};
  fetchCalls.push({ url, body });
  const action = body.action;
  // Never resolves within one flush -- simulates the in-flight window a
  // real double-click races against.
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true,
    json: async () => fetchResponses[action] ?? { status: action },
  }), 50));
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchCalls.length = 0;
  fetchResponses = { approve: { status: 'processing' }, reject: { status: 'rejected' }, cancel: { status: 'cancelled' } };
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

async function mount() {
  root = createRoot(container);
  act(() => { root.render(<AdminPayoutsScreen />); });
  await flush();
}

describe('AdminPayoutsScreen: Approve requires confirmation', () => {
  it('clicking "Approve & Pay" does NOT call the API directly -- it opens a confirmation modal first', async () => {
    await mount();
    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve & Pay')!;
    await act(async () => { approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(container.textContent).toContain('Approve this payout?');
  });

  it('confirming the modal with the required typed word actually sends the approve action', async () => {
    await mount();
    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve & Pay')!;
    await act(async () => { approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const typedInput = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(typedInput, 'APPROVE');
    typedInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve & Pay' && b !== approveBtn)!;
    await act(async () => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(fetchCalls.filter((c) => c.body.action === 'approve').length).toBe(1);
  });
});

describe('AdminPayoutsScreen: double-submission guard', () => {
  it('a rapid double-click on the Reject ConfirmModal Confirm button sends exactly ONE reject request', async () => {
    await mount();
    const rejectBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel Request')!;
    await act(async () => { rejectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const typedInput = container.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(typedInput, 'CANCEL');
    typedInput.dispatchEvent(new Event('input', { bubbles: true }));
    const reasonInput = Array.from(container.querySelectorAll('textarea')).find((el) => (el as HTMLTextAreaElement).placeholder?.includes('rejecting')) as HTMLTextAreaElement;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    textareaSetter.call(reasonInput, 'test reason');
    reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel request')!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(fetchCalls.filter((c) => c.body.action === 'reject').length).toBe(1);
  });
});
