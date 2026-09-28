import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { WalletScreen } from './WalletScreen';

// Regression tests for audit issue #3: handleWithdraw relied only on the
// `withdrawing` React state to guard against re-entrancy, which doesn't
// become true until the next render -- a rapid mobile double-tap could
// invoke it twice before that commits, creating two withdrawal requests.
// Fixed with a synchronous `withdrawingRef`, the same pattern
// CheckoutScreen.tsx already uses (`payingRef`) for ticket purchase.

const rpcMock = vi.fn();
function makeQuery(result: { data: any; error: any }) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    range: () => chain,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

const BANK_ACCOUNT = { id: 'bank-1', bank_name: 'Test Bank', bank_code: '001', account_number: '0000000000', account_name: 'Test Organizer', recipient_code: 'RCP_1', is_default: true };

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'organizer_wallets') return makeQuery({ data: { balance_kobo: 500_000_00, total_earned_kobo: 500_000_00, pending_kobo: 0 }, error: null });
      if (table === 'organizer_transactions') return makeQuery({ data: [], error: null });
      if (table === 'organizer_withdrawal_requests') return makeQuery({ data: [], error: null });
      if (table === 'organizer_bank_accounts') return makeQuery({ data: [BANK_ACCOUNT], error: null });
      return makeQuery({ data: null, error: null });
    },
    rpc: (...args: any[]) => rpcMock(...args),
  },
  getAuthToken: vi.fn(async () => 'token'),
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } }));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { withdrawalRequested: vi.fn() } }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
    if (fn === 'request_organizer_payout') return Promise.resolve({ error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <WalletScreen
        currentUser={{ id: 'org-1', email: 'org@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true }}
        onBack={() => {}}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openWithdrawModalAndEnterAmount(amount: string) {
  const openButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Withdraw' && !b.hasAttribute('data-modal-submit'));
  act(() => { openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  const input = container!.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, amount);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function getWithdrawSubmitButton() {
  // The modal's submit button reads "Withdraw" or "Processing…"; the one
  // that opens the modal only ever reads "Withdraw" and is not inside the
  // modal, so distinguish by picking the LAST such button once the modal
  // is open (submit button is rendered after the trigger in DOM order).
  const candidates = Array.from(container!.querySelectorAll('button')).filter((b) => b.textContent === 'Withdraw' || b.textContent === 'Processing…');
  return candidates[candidates.length - 1];
}

describe('WalletScreen: handleWithdraw re-entrancy guard', () => {
  it('a rapid double-tap only creates ONE withdrawal request', async () => {
    await renderScreen();
    await openWithdrawModalAndEnterAmount('5000');

    let resolveRpc: (v: any) => void = () => {};
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'request_organizer_payout') return new Promise((resolve) => { resolveRpc = resolve; });
      if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const submitButton = getWithdrawSubmitButton();
    act(() => {
      submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const payoutCalls = rpcMock.mock.calls.filter((c) => c[0] === 'request_organizer_payout');
    expect(payoutCalls.length).toBe(1);

    await act(async () => {
      resolveRpc({ error: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('the guard resets after a failure so a legitimate retry works', async () => {
    await renderScreen();
    await openWithdrawModalAndEnterAmount('5000');

    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'request_organizer_payout') return Promise.resolve({ error: { message: 'Paystack unavailable' } });
      if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      getWithdrawSubmitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('Paystack unavailable');

    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'request_organizer_payout') return Promise.resolve({ error: null });
      if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      getWithdrawSubmitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const payoutCalls = rpcMock.mock.calls.filter((c) => c[0] === 'request_organizer_payout');
    expect(payoutCalls.length).toBe(2);
  });

  it('the guard resets after success', async () => {
    await renderScreen();
    await openWithdrawModalAndEnterAmount('5000');

    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'request_organizer_payout') return Promise.resolve({ error: null });
      if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    await act(async () => {
      getWithdrawSubmitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const payoutCalls = rpcMock.mock.calls.filter((c) => c[0] === 'request_organizer_payout');
    expect(payoutCalls.length).toBe(1);
  });
});
