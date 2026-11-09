import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { WalletScreen } from './WalletScreen';

// 0211: the withdrawal PIN replaces Face ID. These tests drive the real
// screen against a mocked database that has 0211: create + confirm the PIN,
// enter it for every withdrawal (request_withdrawal, never the old
// request_organizer_payout), wrong/locked PIN handling, change via the
// password gate, the authoritative stage in the history, and no biometric
// option anywhere.

const rpcMock = vi.fn();
const fetchMock = vi.fn();
let pinState: any;
let myWithdrawals: any[];
let requestRows: any[];

function makeQuery(result: { data: any; error: any }) {
  const chain: any = {
    select: () => chain, eq: () => chain, in: () => chain, order: () => chain, range: () => chain,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}
const BANK_ACCOUNT = { id: 'bank-1', bank_name: 'GTBank', bank_code: '058', account_number: '0123456789', account_name: 'Ada', recipient_code: 'RCP_1', is_default: true };

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'organizer_wallets') return makeQuery({ data: { balance_kobo: 100_000_00, total_earned_kobo: 100_000_00, pending_kobo: 0 }, error: null });
      if (table === 'organizer_transactions') return makeQuery({ data: [], error: null });
      if (table === 'organizer_withdrawal_requests') return makeQuery({ data: requestRows, error: null });
      if (table === 'organizer_bank_accounts') return makeQuery({ data: [BANK_ACCOUNT], error: null });
      return makeQuery({ data: null, error: null });
    },
    rpc: (...args: any[]) => rpcMock(...args),
  },
  getAuthToken: vi.fn(async () => 'token'),
}));
vi.mock('../../lib/analyticsEvents', () => ({ analytics: { withdrawalRequested: vi.fn() } }));
vi.mock('../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

beforeAll(() => {
  if (typeof (globalThis as any).ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (typeof document.elementFromPoint !== 'function') document.elementFromPoint = () => null;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  pinState = { has_pin: true, locked: false, locked_until: null, must_reset: false, attempts_left: 5, withdrawals_paused_until: null };
  myWithdrawals = [];
  requestRows = [];
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string, params: any) => {
    if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
    if (fn === 'get_my_withdrawal_pin_status') return Promise.resolve({ data: pinState, error: null });
    if (fn === 'get_my_withdrawals') return Promise.resolve({ data: myWithdrawals, error: null });
    if (fn === 'set_my_withdrawal_pin') {
      pinState = { ...pinState, has_pin: true };
      return Promise.resolve({ data: pinState, error: null });
    }
    if (fn === 'request_withdrawal') {
      return Promise.resolve({ data: params.p_pin === '7391' ? { ok: true, request_id: 'w-1' } : { ok: false, code: 'wrong_pin', attempts_left: 4, message: 'Wrong PIN. 4 attempts left' }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, pin_status: { has_pin: true, withdrawals_paused_until: '2026-11-10T12:00:00Z' } }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
  await new Promise((r) => setTimeout(r, 80)); // let input-otp's timers drain
});

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

async function renderScreen() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<WalletScreen currentUser={{ id: 'org-1', email: 'org@example.com', full_name: 'Ada', role: 'user', isOrganizer: true }} onBack={() => {}} />);
    await flush();
  });
  await act(async () => { await flush(); });
}

const byTestId = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
};
const setValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
};
const pinInput = (label: string) => container!.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

async function openWithdraw() {
  const open = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Withdraw' && !b.hasAttribute('data-testid'));
  await click(open!);
}

describe('WalletScreen: withdrawal PIN', () => {
  it('has no Face ID / biometric option anywhere', async () => {
    await renderScreen();
    await openWithdraw();
    expect(container!.textContent).not.toMatch(/Face ID|Touch ID|biometric/i);
  });

  it('first withdrawal: the user must create the PIN and enter it twice', async () => {
    pinState = { ...pinState, has_pin: false };
    await renderScreen();
    expect(byTestId('withdrawal-pin-row')!.textContent).toMatch(/Not set/);
    await openWithdraw();
    expect(byTestId('create-withdrawal-pin')).toBeTruthy();
    expect(byTestId('withdraw-submit')).toBeNull(); // no withdrawing before a PIN exists

    await setValue(pinInput('Create your withdrawal PIN'), '1234');
    await click(byTestId('create-withdrawal-pin-submit'));
    expect(byTestId('create-withdrawal-pin-error')!.textContent).toMatch(/too easy to guess/);

    await setValue(pinInput('Create your withdrawal PIN'), '7391');
    await click(byTestId('create-withdrawal-pin-submit'));
    await setValue(pinInput('Create your withdrawal PIN'), '7392');
    await click(byTestId('create-withdrawal-pin-submit'));
    expect(byTestId('create-withdrawal-pin-error')!.textContent).toMatch(/do not match/);
    expect(rpcMock.mock.calls.some((c) => c[0] === 'set_my_withdrawal_pin')).toBe(false);

    await setValue(pinInput('Create your withdrawal PIN'), '7391');
    await click(byTestId('create-withdrawal-pin-submit'));
    await setValue(pinInput('Create your withdrawal PIN'), '7391');
    await click(byTestId('create-withdrawal-pin-submit'));
    const call = rpcMock.mock.calls.find((c) => c[0] === 'set_my_withdrawal_pin');
    expect(call![1]).toEqual({ p_pin: '7391', p_pin_confirm: '7391' });
    expect(byTestId('withdrawal-pin-entry')).toBeTruthy(); // now asks for it to withdraw
  });

  it('the PIN is masked on screen', async () => {
    await renderScreen();
    await openWithdraw();
    await setValue(pinInput('Withdrawal PIN'), '73');
    const entry = byTestId('withdrawal-pin-entry')!;
    expect(entry.textContent).toContain('••');
    expect(entry.textContent).not.toContain('73');
  });

  it('every withdrawal goes through request_withdrawal with the PIN, never the old entry point', async () => {
    await renderScreen();
    await openWithdraw();
    await setValue(container!.querySelector('input[type="number"]') as HTMLInputElement, '5000');
    await setValue(pinInput('Withdrawal PIN'), '7391');
    await click(byTestId('withdraw-submit'));
    const call = rpcMock.mock.calls.find((c) => c[0] === 'request_withdrawal');
    expect(call![1]).toMatchObject({ p_amount_kobo: 500000, p_bank_account_id: 'bank-1', p_pin: '7391' });
    expect(typeof call![1].p_idempotency_key).toBe('string');
    expect(rpcMock.mock.calls.some((c) => c[0] === 'request_organizer_payout')).toBe(false);
    expect(byTestId('withdraw-submit')).toBeNull(); // sheet closed on success
  });

  it('without a PIN typed, nothing is sent', async () => {
    await renderScreen();
    await openWithdraw();
    await setValue(container!.querySelector('input[type="number"]') as HTMLInputElement, '5000');
    await click(byTestId('withdraw-submit'));
    expect(byTestId('withdraw-error')!.textContent).toMatch(/4-digit withdrawal PIN/);
    expect(rpcMock.mock.calls.some((c) => c[0] === 'request_withdrawal')).toBe(false);
  });

  it('a wrong PIN shows the server message, clears the PIN and keeps the sheet open', async () => {
    await renderScreen();
    await openWithdraw();
    await setValue(container!.querySelector('input[type="number"]') as HTMLInputElement, '5000');
    await setValue(pinInput('Withdrawal PIN'), '0007');
    await click(byTestId('withdraw-submit'));
    expect(byTestId('withdraw-error')!.textContent).toBe('Wrong PIN. 4 attempts left');
    expect(pinInput('Withdrawal PIN').value).toBe('');
    expect(byTestId('withdraw-submit')).toBeTruthy();
  });

  it('a locked PIN cannot be used and offers the password reset', async () => {
    pinState = { ...pinState, must_reset: true, locked: true };
    await renderScreen();
    await openWithdraw();
    expect(byTestId('withdrawal-pin-locked')!.textContent).toMatch(/Reset it with your password/);
    expect((byTestId('withdraw-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId('forgot-withdrawal-pin')!.textContent).toMatch(/Reset PIN with your password/);
  });

  it('changing the PIN: new PIN twice, then the password, sent to the API (never to the database directly)', async () => {
    await renderScreen();
    await click(byTestId('change-withdrawal-pin-open'));
    await setValue(pinInput('Change your withdrawal PIN'), '5820');
    await click(byTestId('change-withdrawal-pin-submit'));
    await setValue(pinInput('Change your withdrawal PIN'), '5820');
    await click(byTestId('change-withdrawal-pin-submit'));
    // The password gate
    expect(container!.textContent).toMatch(/Change your withdrawal PIN\. For your security, re-enter your password/);
    await setValue(container!.querySelector('input[placeholder="Your account password"]') as HTMLInputElement, 'pw-123');
    const confirm = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
    await click(confirm!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/wallet/save-bank');
    expect(JSON.parse(init.body)).toEqual({ action: 'reset_withdrawal_pin', password: 'pw-123', pin: '5820', pin_confirm: '5820' });
    expect(rpcMock.mock.calls.some((c) => c[0] === 'reset_my_withdrawal_pin')).toBe(false);
  });

  it('if the PIN status cannot be loaded, it says so and nothing can be sent', async () => {
    const base = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((fn: string, params: any) => (fn === 'get_my_withdrawal_pin_status'
      ? Promise.resolve({ data: null, error: { code: '500', message: 'network error' } })
      : base(fn, params)));
    await renderScreen();
    await openWithdraw();
    expect(byTestId('withdrawal-pin-unavailable')).toBeTruthy();
    expect((byTestId('withdraw-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(rpcMock.mock.calls.some((c) => c[0] === 'request_withdrawal' || c[0] === 'request_organizer_payout')).toBe(false);
  });

  it('the history shows the authoritative stage', async () => {
    requestRows = [{ id: 'w-9', amount_kobo: 300000, status: 'pending', bank_name: 'GTBank', bank_code: '058', account_number: '0123456789', account_name: 'Ada', paystack_reference: null, transfer_code: null, admin_note: null, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:05:00Z' }];
    myWithdrawals = [{ request_id: 'w-9', stage: 'pending_second_approval' }];
    await renderScreen();
    expect(byTestId('withdrawal-stage-w-9')!.textContent).toMatch(/Waiting for second approval/);
  });
});
