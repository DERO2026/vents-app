import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Pre-release review of event cancellation: a refund whose Paystack outcome is
// UNCERTAIN must never be released back to 'paid'. A released ticket can be
// refunded again (event cancellations retry failed refunds automatically), and
// for a multi-ticket payment Paystack would accept that second partial refund.
// Only a definitive rejection (4xx with status:false) releases the claim. An
// accepted refund whose id could not be recorded is reported, because the
// refund webhook finds the ticket only by that id.

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({ mockCallProjectAdminRpc: vi.fn() }));
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminRpc: mockCallProjectAdminRpc }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));

import handler from '../wallet/refund-ticket';

const PENDING = { status: 'refund_pending', payment_ref: 'pay-ref-1', amount_kobo: 1015000 };
function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res); res.json = vi.fn(() => res); res.end = vi.fn(() => res); res.setHeader = vi.fn();
  return res;
}
const req = (body: any) => ({ method: 'POST', headers: { authorization: 'Bearer tok' }, body }) as any;
type Paystack = () => Promise<any>;
function mockFetch(paystack: Paystack, opts: { attachOk?: boolean[] } = {}) {
  const calls: string[] = [];
  const attach = [...(opts.attachOk ?? [true])];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/rpc/refund_ticket') || url.includes('/rpc/cancel_service_booking')) return { ok: true, status: 200, json: async () => PENDING } as any;
    if (url.includes('/rpc/attach_')) { const ok = attach.length ? attach.shift()! : true; return { ok, status: ok ? 200 : 503, json: async () => ({}) } as any; }
    if (url.includes('/rpc/admin_revert_stuck')) return { ok: true, status: 200, json: async () => 'reverted' } as any;
    if (url.includes('api.paystack.co/refund')) return paystack();
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  return { fn, calls };
}
const reverted = (calls: string[]) => calls.some((u) => u.includes('/rpc/admin_revert_stuck'));
const paystackCalls = (calls: string[]) => calls.filter((u) => u.includes('api.paystack.co/refund')).length;

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset(); mockCallProjectAdminRpc.mockResolvedValue(undefined);
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('refund-ticket: uncertain Paystack outcomes are never released', () => {
  const uncertain: [string, Paystack][] = [
    ['a 5xx from Paystack', async () => ({ ok: false, status: 502, json: async () => ({ status: false, message: 'Bad gateway' }) })],
    ['a 5xx with a non-JSON body', async () => ({ ok: false, status: 504, json: async () => { throw new Error('not json'); } })],
    ['a success-shaped answer without a refund id', async () => ({ ok: true, status: 200, json: async () => ({ status: true, data: {} }) })],
    ['a network error after the request was sent', async () => { throw new TypeError('fetch failed'); }],
    ['no answer in time', async () => { throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }); }],
  ];
  for (const [label, paystack] of uncertain) {
    it(`${label}: the ticket stays refund_pending (unconfirmed), nothing is reverted`, async () => {
      const { fn, calls } = mockFetch(paystack);
      vi.stubGlobal('fetch', fn);
      const res = makeRes();
      await handler(req({ ticket_id: 't1', reason: 'Event cancelled: venue closed' }), res);
      expect(paystackCalls(calls)).toBe(1);
      expect(reverted(calls)).toBe(false);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json.mock.calls[0][0]).toMatchObject({ unconfirmed: true });
      expect(res.json.mock.calls[0][0].error).toMatch(/check Paystack before retrying or reverting/);
    });
  }

  it('the same rule applies to service-booking refunds (shared code path)', async () => {
    const { fn, calls } = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({ status: false }) }));
    vi.stubGlobal('fetch', fn);
    await handler(req({ booking_id: 'b1', reason: 'Provider cancelled' }), makeRes());
    expect(reverted(calls)).toBe(false);
  });

  it('a definitive rejection (4xx, status:false) still releases the ticket, as before', async () => {
    const { fn, calls } = mockFetch(async () => ({ ok: false, status: 400, json: async () => ({ status: false, message: 'Transaction has been fully reversed' }) }));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ ticket_id: 't1', reason: 'Event cancelled' }), res);
    expect(reverted(calls)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0]).toEqual({ error: 'Transaction has been fully reversed' });
  });

  it('the Paystack call carries a timeout, and the amount is the server amount, unchanged', async () => {
    let init: any = null;
    const { fn } = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ status: true, data: { id: 9 } }) }));
    vi.stubGlobal('fetch', vi.fn(async (url: string, i: any) => { if (url.includes('paystack.co')) init = i; return fn(url); }));
    await handler(req({ ticket_id: 't1', reason: 'Event cancelled' }), makeRes());
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ transaction: 'pay-ref-1', amount: 1015000, merchant_note: 'Event cancelled' });
  });
});

describe('refund-ticket: the accepted refund id must be recorded', () => {
  const accepted: Paystack = async () => ({ ok: true, status: 200, json: async () => ({ status: true, data: { id: 4242 } }) });

  it('a transient attach failure is retried once', async () => {
    const { fn, calls } = mockFetch(accepted, { attachOk: [false, true] });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ ticket_id: 't1', reason: 'Event cancelled' }), res);
    expect(calls.filter((u) => u.includes('/rpc/attach_ticket_refund_id')).length).toBe(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toEqual({ status: 'refund_pending', refund_id: '4242' });
  });

  it('if it still fails, the refund id is reported (202), never dropped and never reverted', async () => {
    const { fn, calls } = mockFetch(accepted, { attachOk: [false, false] });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ ticket_id: 't1', reason: 'Event cancelled' }), res);
    expect(reverted(calls)).toBe(false);
    expect(paystackCalls(calls)).toBe(1);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json.mock.calls[0][0]).toEqual({ status: 'refund_pending', refund_id: '4242', refund_id_recorded: false });
    expect((console.error as any).mock.calls.some((c: any[]) => String(c[0]).includes('REFUND ID NOT RECORDED') && c.includes('4242'))).toBe(true);
  });
});
