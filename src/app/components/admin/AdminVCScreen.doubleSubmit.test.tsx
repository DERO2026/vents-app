import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminVCScreen } from './AdminVCScreen';

// Regression coverage for a confirmed bug: admin_credit_vents_cents /
// admin_debit_vents_cents's p_idempotency_key is minted fresh
// (crypto.randomUUID()) INSIDE doCredit()/doDebit() on every call, and
// ConfirmModal's own Confirm button has no busy/disabled state of its own
// -- so a fast double-click on that one button (before React unmounts it)
// could invoke doCredit()/doDebit() twice, each with a DIFFERENT
// idempotency key, each recorded by the server as a separate, individually
// valid credit or debit. The server's real idempotency guard (a unique
// constraint on that key, confirmed live) only protects against a literal
// retry of the SAME outgoing request -- it does nothing here. This test
// proves the fix: a synchronous useRef single-flight guard (mirroring
// CheckoutScreen.tsx's payingRef) makes a second, concurrent invocation of
// doCredit()/doDebit() a no-op, regardless of how many times the handler
// is called before the first one resolves.

const selectedUserRow = { id: 'u1', full_name: 'Test User', username: 'testuser', email: 'test@example.com', avatar_url: null };
const rpcCalls: { name: string; args: any }[] = [];

vi.mock('../../../lib/supabase', () => {
  const rpcResponses: Record<string, any> = {
    admin_get_vc_aggregates: { data: [{ circulation: 1000, total_txns: 5, credits: 3, debits: 2 }], error: null },
    admin_get_vc_pool_status: { data: { total_supply: 1000000000, pool_balance: 899501160, total_user_vc_outstanding: 100498840 }, error: null },
    admin_get_user_vc_summary: { data: { balance: 2500, lifetime_earned: 1500, tier: 'silver', multiplier: 1.1 }, error: null },
  };
  function makeQuery(resolveData: any[]) {
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (col: string, val: any) => { resolveData = resolveData.filter((r: any) => r[col] === val); return q; },
      or: () => q,
      limit: () => q,
      then: (resolve: any) => resolve({ data: resolveData, error: null }),
    };
    return q;
  }
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'users') return makeQuery([selectedUserRow]);
        return makeQuery([]);
      },
      rpc: (name: string, args: any) => {
        if (name === 'admin_credit_vents_cents' || name === 'admin_debit_vents_cents') {
          rpcCalls.push({ name, args });
          // Never resolves within this test's flush window -- simulates the
          // in-flight state a real double-click would race against. Each
          // call that DOES get through still resolves eventually so the
          // component doesn't hang forever if the guard fails.
          return new Promise((resolve) => setTimeout(() => resolve({ data: { new_balance: 3500, target_balance: 1500 }, error: null }), 50));
        }
        return Promise.resolve(rpcResponses[name] ?? { data: null, error: null });
      },
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rpcCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function selectUserAndFillCredit(amount: string, reason: string) {
  root = createRoot(container);
  act(() => { root.render(<AdminVCScreen />); });
  await flush();

  const searchInput = container.querySelector('input[placeholder*="Search by name"]') as HTMLInputElement;
  setNativeValue(searchInput, 'testuser');
  const findBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Find')!;
  await act(async () => { findBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  await flush();
  const resultBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Test User'))!;
  await act(async () => { resultBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();

  const creditInput = container.querySelector('input[placeholder="Amount (VC)"]') as HTMLInputElement;
  setNativeValue(creditInput, amount);
  const reasonInput = Array.from(container.querySelectorAll('input[placeholder="Reason (required)"]'))[0] as HTMLInputElement;
  setNativeValue(reasonInput, reason);
  await flush();
}

describe('AdminVCScreen: credit double-submission', () => {
  it('a rapid double-click on the ConfirmModal Confirm button fires exactly ONE admin_credit_vents_cents call', async () => {
    await selectUserAndFillCredit('1000', 'test credit');

    const creditTrigger = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Credit VC to User')!;
    await act(async () => { creditTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Credit')!;
    // Two click events on the SAME still-mounted button, before the first
    // await inside doCredit() has a chance to flip creditInFlightRef --
    // this is the exact race a fast double-click or double-tap reproduces.
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(rpcCalls.filter((c) => c.name === 'admin_credit_vents_cents').length).toBe(1);
  });
});

describe('AdminVCScreen: debit double-submission', () => {
  it('a rapid double-click on the ConfirmModal Confirm button fires exactly ONE admin_debit_vents_cents call', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminVCScreen />); });
    await flush();

    const searchInput = container.querySelector('input[placeholder*="Search by name"]') as HTMLInputElement;
    setNativeValue(searchInput, 'testuser');
    const findBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Find')!;
    await act(async () => { findBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    const resultBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Test User'))!;
    await act(async () => { resultBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const amountInputs = Array.from(container.querySelectorAll('input[placeholder="Amount (VC)"]'));
    setNativeValue(amountInputs[1] as HTMLInputElement, '500');
    const reasonInputs = Array.from(container.querySelectorAll('input[placeholder="Reason (required)"]'));
    setNativeValue(reasonInputs[1] as HTMLInputElement, 'test debit');
    await flush();

    const debitTrigger = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Debit VC from User')!;
    await act(async () => { debitTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Debit')!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(rpcCalls.filter((c) => c.name === 'admin_debit_vents_cents').length).toBe(1);
  });
});
