import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// The screen-wide "Reconcile Processing" reads admin_list_processing_payouts,
// which refuses sub-admins: it is not shown to them. After a Reconcile the
// request list is re-read (it used to reload only the wallets, so a request
// Paystack had already paid stayed on screen as Processing).

const panelRenders: number[] = [];
vi.mock('./PayoutRequestsPanel', () => ({
  PayoutRequestsPanel: ({ refreshSignal }: { refreshSignal?: number }) => { panelRenders.push(refreshSignal ?? 0); return null; },
}));
vi.mock('./EarningsAdjustmentForm', () => ({ EarningsAdjustmentForm: () => null }));
vi.mock('../../../lib/supabase', () => {
  const q: any = { select: () => q, order: () => q, limit: () => q, in: () => q, maybeSingle: () => Promise.resolve({ data: null, error: null }), then: (r: any) => r({ data: [], error: null }) };
  return { supabase: { from: () => q, rpc: () => Promise.resolve({ data: [], error: null }), auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }) } } };
});
vi.mock('../../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

import { AdminPayoutsScreen } from './AdminPayoutsScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  panelRenders.length = 0;
  (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ checked: 2, deferred_count: 0, results: [{ outcome: 'completed' }, { outcome: 'reversed' }] }) }));
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); container = null; root = null; });

async function render(isSuperAdmin: boolean) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<AdminPayoutsScreen isSuperAdmin={isSuperAdmin} />); await flush(); });
}

describe('AdminPayoutsScreen: Reconcile Processing', () => {
  it('is not shown to a sub-admin (the server would refuse it)', async () => {
    await render(false);
    expect(q('payout-reconcile-all')).toBeNull();
    expect(q('payout-exceptions-check')).toBeTruthy();
  });

  it('a full admin reconciles; the request list is re-read and every resolution counted', async () => {
    await render(true);
    const before = panelRenders[panelRenders.length - 1];
    await act(async () => { q('payout-reconcile-all')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect((globalThis as any).fetch).toHaveBeenCalledWith('/api/v1/wallet/reconcile-payouts', expect.objectContaining({ method: 'POST' }));
    expect(panelRenders[panelRenders.length - 1]).toBe(before + 1);
    expect(container!.textContent).toMatch(/Checked 2 processing payout\(s\) against Paystack — 2 resolved/);
  });
});
