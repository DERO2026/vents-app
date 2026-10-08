import { describe, it, expect, vi, beforeEach } from 'vitest';

// Paystack financial-exposure audit finding: api/promotions/activate.ts's
// GET /transaction/verify/:reference call had no rate limit at all -- an
// authenticated user could repeatedly call it with arbitrary reference
// values, each one a real Paystack API request. activate_event_promotion's
// own idempotency (ON CONFLICT DO NOTHING on payment_ref) already prevents
// any duplicate activation, so this was never a duplicate-money risk --
// these tests prove the new paystack_promotion_verify:<userId> gate (30/hr,
// matching resolve-account.ts's ceiling) actually blocks BEFORE the
// Paystack call, fails closed on any error, and leaves the existing
// idempotent activation behavior intact.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: mockVerifyInsforgeSession }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));

import handler from '../promotions/activate';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

function req(body: any, authorization = 'Bearer tok') {
  return { method: 'POST', headers: { authorization }, body } as any;
}

const VALID_BODY = { event_id: 'event-1', reference: 'ref-abc', plan: 'spotlight', duration_days: 7 };

function makePaystackFetchMock() {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('api.paystack.co')) {
      return { ok: true, json: async () => ({ status: true, data: { status: 'success', amount: 1000000 } }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  });
  return { fn, calls };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
});

describe('promotions/activate: Paystack verification rate limit', () => {
  it('1. under 30/hour, verification is allowed and Paystack is called', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn, calls } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_promotion_verify:user-1', 30, 3600]);
    expect(calls.some((u) => u.includes('api.paystack.co'))).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('2. 30/hour reached is rejected with 429', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('3. a rate-limit RPC/infra failure (not a genuine hit) also fails CLOSED', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated'));
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('4. Paystack is never called after a rate-limit rejection', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, calls } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req(VALID_BODY), makeRes());
    expect(calls.some((u) => u.includes('api.paystack.co'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('5. existing idempotent activation behavior is unchanged when the rate limit passes', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string) => {
      if (fnName === 'check_rate_limit') return undefined;
      if (fnName === 'activate_event_promotion') return undefined; // idempotent no-op on repeat
      return undefined;
    });
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('activate_event_promotion', ['event-1', 'boosted', 7, 'ref-abc', 'user-1']);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('6. existing authentication behavior is intact -- no session still 401s before the rate limit is checked', async () => {
    mockVerifyInsforgeSession.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('7. existing request validation still runs before the rate limit (invalid plan never reaches check_rate_limit)', async () => {
    const res = makeRes();
    await handler(req({ ...VALID_BODY, plan: 'not-a-real-plan' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });
});
