import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Upheld booking disputes are refunded through the existing booking refund
// route (api/wallet/refund-ticket.ts -> cancel_service_booking). The
// database decides whether a completed booking may be refunded (only with
// a dispute two admins upheld for the customer); these tests pin that the
// route never calls Paystack when the database refuses, and sends exactly
// the database's amount when it allows. No network.

const adminRpc = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminRpc: (...a: unknown[]) => adminRpc(...a) }));
vi.mock('./cors.js', () => ({ applyCors: () => false }));

const SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co';
let cancelResponse: () => Response;
const calls: { url: string; body?: any }[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/rpc/cancel_service_booking')) return cancelResponse();
    if (url === 'https://api.paystack.co/refund') return json(200, { status: true, data: { id: 777 } });
    if (url.endsWith('/rpc/attach_service_booking_refund_id')) return json(200, null);
    if (url.endsWith('/rpc/admin_revert_stuck_service_refund')) return json(200, 'reverted');
    throw new Error(`unexpected fetch ${url}`);
  }));
  Object.assign(process.env, { VERCEL_ENV: 'production', VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: 'anon', PAYSTACK_SECRET_KEY: 'sk_test_x' });
});
afterEach(() => { vi.unstubAllGlobals(); });

function mockRes() {
  const res: any = { statusCode: 0 };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
async function refund() {
  const res = mockRes();
  const req = { method: 'POST', headers: { authorization: 'Bearer admin', origin: 'https://getvents.com' }, body: { booking_id: 'bk-1', reason: 'Dispute upheld' }, query: {} } as any;
  await (await import('../wallet/refund-ticket')).default(req, res);
  return res;
}
const paystackCalls = () => calls.filter((c) => c.url === 'https://api.paystack.co/refund');

describe('refunding a disputed, completed booking', () => {
  it('the database refuses (no upheld dispute): the error is returned and Paystack is never called', async () => {
    cancelResponse = () => json(400, { message: 'A completed booking cannot be cancelled or refunded' });
    const res = await refund();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/completed booking cannot be cancelled/);
    expect(paystackCalls()).toHaveLength(0);
  });

  it('upheld (Paystack booking): refunds exactly the amount the database returned, against the original payment', async () => {
    cancelResponse = () => json(200, { status: 'refund_pending', booking_id: 'bk-1', payment_ref: 'BKN-REF', amount_kobo: 105000 });
    const res = await refund();
    expect(res.statusCode).toBe(200);
    expect(paystackCalls()).toHaveLength(1);
    expect(paystackCalls()[0].body).toMatchObject({ transaction: 'BKN-REF', amount: 105000 });
    expect(calls.some((c) => c.url.endsWith('/rpc/attach_service_booking_refund_id') && c.body.p_refund_id === '777')).toBe(true);
  });

  it('upheld (VENTS Wallet booking): refunded inside the database, no Paystack call', async () => {
    cancelResponse = () => json(200, { status: 'refunded', booking_id: 'bk-1' });
    const res = await refund();
    expect(res.body).toEqual({ status: 'refunded' });
    expect(paystackCalls()).toHaveLength(0);
  });

  it('a repeat after it finished is a no-op', async () => {
    cancelResponse = () => json(200, { status: 'already_refunded', booking_id: 'bk-1' });
    expect((await refund()).body).toEqual({ status: 'already_refunded' });
    expect(paystackCalls()).toHaveLength(0);
  });
});
