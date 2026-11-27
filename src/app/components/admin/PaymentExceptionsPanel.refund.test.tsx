import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// AZ-10 / D4 (migration 0234): the panel offers only the next step of the
// two-admin refund. The database enforces every rule; these tests check the
// panel never offers a shortcut: no "send" before approval, no send for a
// sub-admin, no hand-closing a refund that is approved or in flight, and the
// requested amount can never exceed what Paystack captured.

const rpc = vi.fn();
const getSession = vi.fn(async () => ({ data: { session: { access_token: 'tok_admin' } } }));
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: (n: string, a: any) => rpc(n, a), auth: { getSession: () => getSession() } } }));
vi.mock('../../../lib/apiBase', () => ({ apiUrl: (p: string) => `https://api.test${p}` }));

import { PaymentExceptionsPanel, refundStage, reasonText } from './PaymentExceptionsPanel';

const BASE = {
  id: 'x1', reference: 'PSK-abc', reason: 'not_found', detail: 'sold out', amount_kobo: 1000000, expected_kobo: null,
  source: 'webhook', status: 'open', resolution_note: null, resolved_at: null, seen_count: 1, first_seen_at: '2026-11-26T10:00:00Z',
  buyer_username: 'buyer1', buyer_email: 'b@example.com', event_title: 'Afro Night', kind: 'ticket_purchase',
  refund_status: null, refund_amount_kobo: null, refund_reason: null, refund_requested_by_name: null, refund_approved_by_name: null, refund_error: null,
};

let container: HTMLDivElement; let root: Root;
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(row: any, isSuperAdmin = true) {
  rpc.mockImplementation(async (name: string) => (name === 'admin_list_payment_exceptions' ? { data: [row], error: null } : { data: { id: 'req1' }, error: null }));
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<PaymentExceptionsPanel isSuperAdmin={isSuperAdmin} />); });
  await flush();
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const type = async (id: string, value: string) => {
  const el = q(id) as HTMLInputElement | HTMLTextAreaElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockReset(); vi.restoreAllMocks(); });

describe('two-admin refund in the payment exceptions panel', () => {
  it('an open exception offers "Request refund" prefilled with the captured amount; it calls only the request RPC', async () => {
    await render(BASE);
    expect(q('payment-exception-send-refund')).toBeNull();
    await act(async () => { q('payment-exception-request-refund')!.click(); });
    expect((q('payment-exception-refund-amount') as HTMLInputElement).value).toBe('10000.00');
    await type('payment-exception-refund-reason', 'Sold out after payment');
    await act(async () => { q('payment-exception-refund-submit')!.click(); }); await flush();
    expect(rpc).toHaveBeenCalledWith('admin_request_payment_exception_refund', { p_id: 'x1', p_amount_kobo: 1000000, p_reason: 'Sold out after payment' });
    expect(q('payment-exceptions-message')!.textContent).toMatch(/different Super Admin must approve/);
  });

  it('refuses more than Paystack captured, zero, and a missing reason before calling the server', async () => {
    await render(BASE);
    await act(async () => { q('payment-exception-request-refund')!.click(); });
    await type('payment-exception-refund-amount', '10000.01');
    await type('payment-exception-refund-reason', 'Sold out after payment');
    await act(async () => { q('payment-exception-refund-submit')!.click(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/cannot be more than Paystack captured/);
    await type('payment-exception-refund-amount', '0');
    await act(async () => { q('payment-exception-refund-submit')!.click(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/greater than zero/);
    await type('payment-exception-refund-amount', '50');
    await type('payment-exception-refund-reason', 'no');
    await act(async () => { q('payment-exception-refund-submit')!.click(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/at least 5 characters/);
    expect(rpc).not.toHaveBeenCalledWith('admin_request_payment_exception_refund', expect.anything());
  });

  it('a requested refund shows it is waiting for a second admin and offers no send', async () => {
    await render({ ...BASE, refund_status: 'requested', refund_amount_kobo: 1000000, refund_requested_by_name: 'sub' });
    expect(q('payment-exception-refund-stage')!.textContent).toMatch(/requested by sub: waiting for a different Super Admin/);
    expect(q('payment-exception-send-refund')).toBeNull();
    expect(q('payment-exception-request-refund')).toBeNull();
  });

  it('a waiting request cannot be closed by hand from the panel', async () => {
    await render({ ...BASE, refund_status: 'requested', refund_amount_kobo: 1000000, refund_request_status: 'pending' });
    expect(q('payment-exception-resolve')).toBeNull();
  });

  it('a request the second admin rejected says so and allows a new request', async () => {
    await render({ ...BASE, refund_status: 'requested', refund_amount_kobo: 1000000, refund_request_status: 'rejected' });
    expect(q('payment-exception-refund-stage')!.textContent).toMatch(/was rejected in Admin Actions/);
    expect(q('payment-exception-request-refund')).toBeTruthy();
    expect(q('payment-exception-send-refund')).toBeNull();
  });

  it('an approved refund: a Super Admin can send it (exact route and body); it can no longer be closed by hand', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: true, json: async () => ({ status: 'refund_pending' }) } as any);
    await render({ ...BASE, refund_status: 'approved', refund_amount_kobo: 400000, refund_reason: 'Partial refund agreed', refund_requested_by_name: 'sub', refund_approved_by_name: 'admin_b' });
    expect(q('payment-exception-refund-stage')!.textContent).toMatch(/approved by sub and admin_b/);
    expect(q('payment-exception-resolve')).toBeNull();
    await act(async () => { q('payment-exception-send-refund')!.click(); }); await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as any[];
    expect(url).toBe('https://api.test/api/v1/wallet/refund-ticket');
    expect(JSON.parse(init.body)).toEqual({ payment_exception_id: 'x1', reason: 'Partial refund agreed' });
    expect(init.headers.Authorization).toBe('Bearer tok_admin');
    expect(q('payment-exceptions-message')!.textContent).toMatch(/completes when Paystack confirms/);
  });

  it('a sub-admin sees an approved refund but cannot send it', async () => {
    await render({ ...BASE, refund_status: 'approved', refund_amount_kobo: 400000 }, false);
    expect(q('payment-exception-send-refund')).toBeNull();
  });

  it('a refund in flight offers nothing (Paystack\'s webhook finishes it)', async () => {
    await render({ ...BASE, refund_status: 'refund_pending', refund_amount_kobo: 400000 });
    expect(q('payment-exception-send-refund')).toBeNull();
    expect(q('payment-exception-request-refund')).toBeNull();
    expect(q('payment-exception-resolve')).toBeNull();
  });

  it('a failed refund says the money is still owed and allows a new request', async () => {
    await render({ ...BASE, refund_status: 'refund_failed', refund_amount_kobo: 400000, refund_error: 'bank rejected' });
    expect(q('payment-exception-refund-stage')!.textContent).toMatch(/bank rejected.*still owed/);
    expect(q('payment-exception-request-refund')).toBeTruthy();
  });

  it('a server error from Send is shown, not swallowed', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: false, json: async () => ({ error: 'This refund has not been approved by two admins' }) } as any);
    await render({ ...BASE, refund_status: 'approved', refund_amount_kobo: 400000 });
    await act(async () => { q('payment-exception-send-refund')!.click(); }); await flush();
    expect(q('payment-exceptions-action-error')!.textContent).toBe('This refund has not been approved by two admins');
  });

  it('without 0234 (no refund fields) the row has no refund flow, exactly as before', async () => {
    const legacy: any = { ...BASE }; for (const k of Object.keys(legacy)) if (k.startsWith('refund_') || k === 'kind') delete legacy[k];
    await render(legacy);
    expect(refundStage(legacy)).toBeNull();
    expect(q('payment-exception-request-refund')).toBeNull();
    expect(q('payment-exception-resolve')!.textContent).toBe('Record resolution');
  });

  it('describes a transfer that could not complete after its fee was paid (0238)', () => {
    expect(reasonText({ ...BASE, kind: 'ticket_transfer_fee', reason: 'transfer_not_completed' } as any)).toMatch(/ticket transfer could not complete/);
  });

  it('describes transfer-fee duplicates', () => {
    expect(reasonText({ ...BASE, kind: 'ticket_transfer_fee', reason: 'duplicate_payment' } as any)).toBe('Second payment of a ticket-transfer fee that was already paid');
  });
});
