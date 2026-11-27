import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// AZ-10 / D4 (migration 0234): api/wallet/refund-ticket.ts sends a two-admin
// approved refund of a payment captured without a ticket. The route never
// decides anything itself: start_payment_exception_refund (database) refuses
// anything not approved by two admins and returns the captured reference and
// the APPROVED amount; the route refunds exactly that, records the refund
// id, and on a definitive Paystack rejection hands the claim back. The same
// uncertain-outcome rule as ticket refunds applies.

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({ mockCallProjectAdminRpc: vi.fn() }));
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminRpc: mockCallProjectAdminRpc }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));

import handler from '../wallet/refund-ticket';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res); res.json = vi.fn(() => res); res.end = vi.fn(() => res); res.setHeader = vi.fn();
  return res;
}
const req = (body: any) => ({ method: 'POST', headers: { authorization: 'Bearer tok_admin' }, body }) as any;

function mockFetch(start: () => Promise<any>, paystack: () => Promise<any>) {
  const calls: { url: string; body: any }[] = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.includes('/rpc/start_payment_exception_refund')) return start();
    if (url.includes('/rpc/attach_payment_exception_refund_id')) return { ok: true, status: 200, json: async () => ({}) } as any;
    if (url.includes('/rpc/admin_revert_payment_exception_refund')) return { ok: true, status: 200, json: async () => ({}) } as any;
    if (url.includes('api.paystack.co/refund')) return paystack();
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  return { fn, calls };
}
const APPROVED = async () => ({ ok: true, status: 200, json: async () => ({ status: 'refund_pending', payment_ref: 'PSK-abc', amount_kobo: 400000 }) });
const PAYSTACK_OK = async () => ({ ok: true, status: 200, json: async () => ({ status: true, data: { id: 98765 } }) });

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset(); mockCallProjectAdminRpc.mockResolvedValue(undefined);
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('refund-ticket: payment_exception_id (two-admin approved refunds)', () => {
  it('claims through start_payment_exception_refund with the admin JWT, refunds exactly the approved amount, records the id', async () => {
    const { fn, calls } = mockFetch(APPROVED, PAYSTACK_OK);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ payment_exception_id: 'x1', reason: 'Sold out after payment' }), res);
    expect(calls[0].url).toBe('https://test.supabase.co/rest/v1/rpc/start_payment_exception_refund');
    expect(calls[0].body).toEqual({ p_payment_exception_id: 'x1', p_reason: 'Sold out after payment' });
    expect((fn.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok_admin');
    const paystack = calls.find((c) => c.url.includes('api.paystack.co/refund'))!;
    expect(paystack.body).toMatchObject({ transaction: 'PSK-abc', amount: 400000 });
    const attach = calls.find((c) => c.url.includes('attach_payment_exception_refund_id'))!;
    expect(attach.body).toEqual({ p_payment_exception_id: 'x1', p_refund_id: '98765' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'refund_pending', refund_id: '98765' });
  });

  it('not approved by two admins: the database refuses, Paystack is never called', async () => {
    const { fn, calls } = mockFetch(async () => ({ ok: false, status: 400, json: async () => ({ message: 'This refund has not been approved by two admins' }) }), PAYSTACK_OK);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ payment_exception_id: 'x1', reason: 'r' }), res);
    expect(calls.some((c) => c.url.includes('api.paystack.co'))).toBe(false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'This refund has not been approved by two admins' });
  });

  it('already refunded: no second Paystack call', async () => {
    const { fn, calls } = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ status: 'already_refunded' }) }), PAYSTACK_OK);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ payment_exception_id: 'x1', reason: 'r' }), res);
    expect(calls.some((c) => c.url.includes('api.paystack.co'))).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ status: 'already_refunded' });
  });

  it('a definitive Paystack rejection hands the claim back (retryable with the same approvals)', async () => {
    const { fn, calls } = mockFetch(APPROVED, async () => ({ ok: false, status: 400, json: async () => ({ status: false, message: 'Insufficient balance' }) }));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ payment_exception_id: 'x1', reason: 'r' }), res);
    const revert = calls.find((c) => c.url.includes('admin_revert_payment_exception_refund'))!;
    expect(revert.body.p_payment_exception_id).toBe('x1');
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it('an uncertain Paystack answer is NOT reverted (the refund may exist)', async () => {
    const { fn, calls } = mockFetch(APPROVED, async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ payment_exception_id: 'x1', reason: 'r' }), res);
    expect(calls.some((c) => c.url.includes('admin_revert_payment_exception_refund'))).toBe(false);
    expect(res.json.mock.calls[0][0]).toMatchObject({ unconfirmed: true });
  });

  it('payment_exception_id cannot be combined with a ticket or booking', async () => {
    const fn = vi.fn(); vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ payment_exception_id: 'x1', ticket_id: 't1', reason: 'r' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(fn).not.toHaveBeenCalled();
  });
});
