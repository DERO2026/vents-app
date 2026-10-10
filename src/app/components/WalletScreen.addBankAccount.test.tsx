import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { WalletScreen } from './WalletScreen';

// "Add Bank Account: Too Many Requests" investigation -- client-side half.
// The server-side misclassification bug (any failure from check_rate_limit
// reported identically as "Too many requests") is covered directly in
// api/wallet/resolveAccountRateLimitClassification.security.test.ts. This
// file covers the other named risk: duplicate submissions from the client
// itself. Add Bank Account's "Confirm" step (password re-entry) relied
// only on `confirmBusy` React state to guard re-entrancy -- state doesn't
// become visible until the next render, so a fast double-tap could invoke
// runConfirm twice before the disabled attribute ever commits, exactly
// the same class of bug this file's sibling (WalletScreen.doubleSubmit.
// test.tsx) already covers for handleWithdraw. Fixed with a synchronous
// confirmBusyRef, same pattern as withdrawingRef/payingRef elsewhere.

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

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'organizer_wallets') return makeQuery({ data: { balance_kobo: 0, total_earned_kobo: 0, pending_kobo: 0 }, error: null });
      if (table === 'organizer_transactions') return makeQuery({ data: [], error: null });
      if (table === 'organizer_withdrawal_requests') return makeQuery({ data: [], error: null });
      if (table === 'organizer_bank_accounts') return makeQuery({ data: [], error: null });
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
let fetchCalls: { url: string; body: any }[] = [];
let resolveSaveBank: (() => void) | null = null;

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'is_email_verified') return Promise.resolve({ data: true, error: null });
    return Promise.resolve({ data: null, error: null });
  });

  fetchCalls = [];
  resolveSaveBank = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    fetchCalls.push({ url, body });
    if (url.includes('/api/v1/wallet/banks')) {
      return { ok: true, json: async () => ({ banks: [{ name: 'Test Bank', code: '058' }] }) };
    }
    if (url.includes('/api/v1/wallet/resolve-account')) {
      return { ok: true, json: async () => ({ account_name: 'Test Person', account_number: '0123456789' }) };
    }
    if (url.includes('/api/v1/wallet/save-bank')) {
      // Deliberately slow -- lets a double-tap land before the first
      // call resolves, matching the real race the synchronous ref fixes.
      return new Promise((resolve) => {
        resolveSaveBank = () => resolve({ ok: true, json: async () => ({ account_name: 'Test Person', recipient_code: 'RCP_1' }) } as any);
      });
    }
    return { ok: true, json: async () => ({}) };
  }));
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function openAddBankAndResolveAccount() {
  const addButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Add Bank');
  await act(async () => {
    addButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  const bankPickerTrigger = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Select bank');
  await act(async () => {
    bankPickerTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  // The PickerSheet's option row is the one matching div with
  // cursor:pointer -- the scroll-list WRAPPER around it also matches
  // textContent === 'Test Bank' when there's only one bank (its own
  // textContent is just its single child's), and comes first in document
  // order, so picking by cursor:pointer (only the real, clickable row has
  // it) instead of a plain textContent match avoids clicking that inert
  // wrapper.
  const bankOption = Array.from(container!.querySelectorAll('div')).find(
    (el) => el.textContent === 'Test Bank' && (el as HTMLElement).style.cursor === 'pointer'
  ) as HTMLElement;
  await act(async () => { bankOption.click(); });

  const accountInput = container!.querySelector('input[placeholder="10-digit account number"]') as HTMLInputElement;
  await act(async () => { setInputValue(accountInput, '0123456789'); });

  // Wait past the 500ms debounce for resolve-account to fire and resolve.
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
}

describe('WalletScreen: Add Bank Account confirm-step re-entrancy guard', () => {
  it('a rapid double-tap on the password Confirm button only sends ONE save-bank request', async () => {
    await renderScreen();
    await openAddBankAndResolveAccount();

    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save');
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Password confirm modal is now open; type a password and double-tap Confirm.
    const pwInput = container!.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pwInput).toBeTruthy();
    await act(async () => { setInputValue(pwInput, 'correct-password'); });

    const confirmButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const saveBankCalls = fetchCalls.filter((c) => c.url.includes('/api/v1/wallet/save-bank'));
    expect(saveBankCalls.length).toBe(1);

    await act(async () => {
      resolveSaveBank?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('a legitimate retry after a failed save still works (the guard resets)', async () => {
    await renderScreen();
    await openAddBankAndResolveAccount();

    const saveButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save');
    await act(async () => { saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });

    const pwInput = container!.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => { setInputValue(pwInput, 'wrong-password'); });

    // First attempt fails.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetchCalls.push({ url, body: null });
      if (url.includes('/api/v1/wallet/save-bank')) return { ok: false, json: async () => ({ error: 'Password confirmation failed. Please re-enter your password.' }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('Password confirmation failed');

    // Retry with the right password succeeds.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetchCalls.push({ url, body: null });
      if (url.includes('/api/v1/wallet/save-bank')) return { ok: true, json: async () => ({ account_name: 'Test Person', recipient_code: 'RCP_1' }) };
      if (url.includes('organizer_bank_accounts')) return { ok: true, json: async () => ([]) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => { setInputValue(container!.querySelector('input[type="password"]') as HTMLInputElement, 'correct-password'); });
    await act(async () => {
      Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Confirm')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const saveBankCalls = fetchCalls.filter((c) => c.url.includes('/api/v1/wallet/save-bank'));
    expect(saveBankCalls.length).toBe(2);
  });
});
