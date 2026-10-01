import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminVCScreen } from './AdminVCScreen';

// Admin Console VC credit/debit UX (Prompt 1): the admin must see the
// selected user's current available VC and, once they type an amount, a
// server-grounded "projected balance" preview before confirming -- and
// must clearly see whether the operation affects Lifetime VC. The preview
// numbers are display-only arithmetic on top of a balance the server
// (admin_get_user_vc_summary) already computed; the actual resulting
// balance is always recomputed and enforced inside the RPC itself, never
// trusted from the client.

const selectedUserRow = { id: 'u1', full_name: 'Test User', username: 'testuser', email: 'test@example.com', avatar_url: null };

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
        if (table === 'vc_reward_campaigns') return makeQuery([]);
        if (table === 'vc_transactions') return makeQuery([]);
        if (table === 'users') return makeQuery([selectedUserRow]);
        return makeQuery([]);
      },
      rpc: (name: string) => Promise.resolve(rpcResponses[name] ?? { data: null, error: null }),
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

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('AdminVCScreen: current/projected balance display', () => {
  it('shows the system pool status cards', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminVCScreen />); });
    await flush();
    expect(container.textContent).toContain('Total VC Supply');
    expect(container.textContent).toContain('1,000,000,000');
    expect(container.textContent).toContain('System Pool Remaining');
    expect(container.textContent).toContain('899,501,160');
  });

  it('shows the selected user\'s current balance, lifetime VC, and tier once selected', async () => {
    root = createRoot(container);
    act(() => { root.render(<AdminVCScreen />); });
    await flush();

    const searchInput = container.querySelector('input[placeholder*="Search by name"]') as HTMLInputElement;
    setNativeValue(searchInput, 'testuser');
    const findBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Find')!;
    await act(async () => { findBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();

    const resultBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Test User'));
    expect(resultBtn).toBeTruthy();
    await act(async () => { resultBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const summary = container.querySelector('[data-testid="admin-vc-user-summary"]');
    expect(summary).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-vc-current-balance"]')?.textContent).toContain('2,500 VC');
    expect(summary?.textContent).toContain('1,500 VC');
    expect(summary?.textContent).toContain('silver');
  });

  it('computes a projected credit balance as current + amount, purely for display', async () => {
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
    setNativeValue(creditInput, '1000');
    await flush();

    const projected = container.querySelector('[data-testid="admin-vc-credit-projected"]');
    expect(projected?.textContent).toContain('3,500 VC');
  });

  it('defaults the "counts toward Lifetime VC" checkbox to unchecked, and reflects the choice in the explanatory text', async () => {
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

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(container.textContent).toContain('Will NOT affect Lifetime VC');

    await act(async () => { checkbox.click(); });
    await flush();
    expect(container.textContent).toContain('Will increase Lifetime VC');
  });
});
