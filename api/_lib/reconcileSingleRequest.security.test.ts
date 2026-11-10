import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// "Check with Paystack" on one processing withdrawal (Admin Payouts card):
// reconcile-payouts with { request_id } runs the same reconciliation,
// narrowed to that one request. It may only narrow what
// admin_list_processing_payouts (full admins, server-checked) returned: an
// unknown or non-processing id touches Paystack and the money functions
// not at all.

const { mockCallProjectAdminTableRpc } = vi.hoisted(() => ({ mockCallProjectAdminTableRpc: vi.fn() }));
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminTableRpc: mockCallProjectAdminTableRpc }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./mailer.js', () => ({ sendPayoutDecisionEmail: vi.fn(async () => {}) }));

import handler from '../wallet/reconcile-payouts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}
const req = (body: any) => ({ method: 'POST', headers: { authorization: 'Bearer tok' }, body } as any);
const row = (id: string, code: string) => ({ request_id: id, organizer_id: 'o', amount_kobo: 100, transfer_code: code, paystack_reference: `ref-${id}`, updated_at: new Date().toISOString() });

let paystackCalls: string[] = [];
beforeEach(() => {
  paystackCalls = [];
  mockCallProjectAdminTableRpc.mockReset();
  mockCallProjectAdminTableRpc.mockResolvedValue([{ status: 'completed', amount_kobo: 100 }]);
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('admin_list_processing_payouts')) return { ok: true, json: async () => [row(A, 'TRF_a'), row(B, 'TRF_b')] } as any;
    if (url.includes('api.paystack.co/transfer/')) { paystackCalls.push(url); return { ok: true, json: async () => ({ data: { status: 'success' } }) } as any; }
    return { ok: true, json: async () => ({}) } as any;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('reconcile-payouts: one request', () => {
  it('checks only the named processing request with Paystack', async () => {
    const res = makeRes();
    await handler(req({ request_id: B }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(paystackCalls).toEqual(['https://api.paystack.co/transfer/TRF_b']);
    expect(mockCallProjectAdminTableRpc).toHaveBeenCalledTimes(1);
    expect(mockCallProjectAdminTableRpc).toHaveBeenCalledWith('complete_organizer_payout', ['TRF_b']);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ checked: 1, results: [expect.objectContaining({ request_id: B, outcome: 'completed' })] }));
  });

  it('a request that is not processing (or unknown) touches nothing: 409', async () => {
    const res = makeRes();
    await handler(req({ request_id: '33333333-3333-4333-8333-333333333333' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(paystackCalls).toEqual([]);
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
  });

  it('a malformed id is refused before anything is read from Paystack', async () => {
    for (const bad of [123, 'x', { a: 1 }, `${A}' OR 1=1`]) {
      const res = makeRes();
      await handler(req({ request_id: bad }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(paystackCalls).toEqual([]);
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
  });

  it('without request_id every processing request is reconciled (unchanged)', async () => {
    const res = makeRes();
    await handler(req({}), res);
    expect(paystackCalls.length).toBe(2);
  });

  it('a non-admin is stopped by admin_list_processing_payouts before Paystack', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('admin_list_processing_payouts')) return { ok: false, status: 400, json: async () => ({ message: 'Super Admin access required' }) } as any;
      paystackCalls.push(url);
      return { ok: true, json: async () => ({}) } as any;
    }));
    const res = makeRes();
    await handler(req({ request_id: A }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(paystackCalls).toEqual([]);
  });
});
