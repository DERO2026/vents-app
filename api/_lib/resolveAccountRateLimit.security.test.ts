import { describe, it, expect, vi, beforeEach } from 'vitest';

// Billing-audit finding: api/wallet/resolve-account.ts spends a real
// Paystack API call per request but had no server-side rate limit --
// only WalletScreen.tsx's own debounce, which a caller hitting this
// endpoint directly simply bypasses. These tests prove the new
// check_rate_limit-based gate (paystack_resolve_account:<userId>, 30/hr)
// actually blocks BEFORE the Paystack fetch, fails closed on any
// unexpected error, and is scoped per-user -- same convention as
// ticketResendRateLimit.security.test.ts (commit 39b5405, untouched by
// this change) and the existing Paystack verify endpoints' enforceRateLimit
// usage (paystackVerifyRateLimit.security.test.ts), adapted here to fail
// closed instead of open since this gate sits directly in front of a
// real third-party spend.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: mockVerifyInsforgeSession }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));

import handler from '../wallet/resolve-account';

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

function makePaystackFetchMock(response: any = { status: true, data: { account_name: 'Jane Doe', account_number: '0123456789' } }) {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls++;
    return { ok: true, json: async () => response } as any;
  });
  return { fn, getCalls: () => calls };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
});

const VALID_BODY = { account_number: '0123456789', bank_code: '058' };

describe('resolve-account: rate-limit gate', () => {
  it('1. a valid request proceeds and resolves successfully when under the limit', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account_name: 'Jane Doe', account_number: '0123456789' });
    vi.unstubAllGlobals();
  });

  it('2. requests below the 30/hour limit are allowed (rate limiter not tripped)', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_resolve_account:user-1', 30, 3600]);
    expect(res.status).not.toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('3. the 31st request (rate limiter rejects) is blocked with 429', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('4. the rate-limit gate executes BEFORE the Paystack fetch', async () => {
    const order: string[] = [];
    mockCallProjectAdminRpc.mockImplementation(async () => { order.push('rate-limit'); });
    const fn = vi.fn(async () => { order.push('paystack'); return { ok: true, json: async () => ({ status: true, data: { account_name: 'A', account_number: '0123456789' } }) } as any; });
    vi.stubGlobal('fetch', fn);
    await handler(req(VALID_BODY), makeRes());
    expect(order).toEqual(['rate-limit', 'paystack']);
    vi.unstubAllGlobals();
  });

  it('5. a rate-limited request makes ZERO Paystack API calls', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, getCalls } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req(VALID_BODY), makeRes());
    expect(getCalls()).toBe(0);
    vi.unstubAllGlobals();
  });

  it('6. the rate limit is keyed per authenticated user', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    mockVerifyInsforgeSession.mockResolvedValueOnce({ userId: 'user-42', email: 'other@example.com' });
    await handler(req(VALID_BODY), makeRes());
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_resolve_account:user-42', 30, 3600]);
    vi.unstubAllGlobals();
  });

  it('7. user A hitting their limit does not block user B', async () => {
    const { fn } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);

    mockVerifyInsforgeSession.mockResolvedValueOnce({ userId: 'user-A', email: 'a@example.com' });
    mockCallProjectAdminRpc.mockImplementationOnce(async (_fn: string, args: any[]) => {
      if (args[0] === 'paystack_resolve_account:user-A') throw new Error('rate_limited');
    });
    const resA = makeRes();
    await handler(req(VALID_BODY), resA);
    expect(resA.status).toHaveBeenCalledWith(429);

    mockVerifyInsforgeSession.mockResolvedValueOnce({ userId: 'user-B', email: 'b@example.com' });
    mockCallProjectAdminRpc.mockResolvedValueOnce(undefined);
    const resB = makeRes();
    await handler(req(VALID_BODY), resB);
    expect(resB.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  // Wallet "Add Bank Account: Too Many Requests" investigation: this used
  // to assert 429 here too -- failing closed (never calling Paystack) is
  // still correct and still tested below, but reporting an unrelated
  // infra failure (a dropped Postgres connection, nothing to do with
  // request volume) as "Too many requests" told users something false
  // about why they were blocked. See resolveAccountRateLimitClassification
  // .security.test.ts for the full investigation and fix -- this specific
  // test is updated to the corrected, honest status code rather than left
  // asserting the bug.
  it('8. an unexpected rate-limit infrastructure failure still fails CLOSED (Paystack never called), but is reported as 503, never as "Too many requests"', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated'));
    const { fn, getCalls } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(getCalls()).toBe(0);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).not.toHaveBeenCalledWith({ error: 'Too many requests. Please try again in a bit.' });
    vi.unstubAllGlobals();
  });

  it('9. that same infrastructure failure makes ZERO Paystack calls', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated'));
    const { fn, getCalls } = makePaystackFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req(VALID_BODY), makeRes());
    expect(getCalls()).toBe(0);
    vi.unstubAllGlobals();
  });

  it('10. existing authentication failure (no session) is unchanged -- 401 before rate limit is even checked', async () => {
    mockVerifyInsforgeSession.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('11. existing validation failures are unchanged (bad account_number / missing bank_code)', async () => {
    const res1 = makeRes();
    await handler(req({ account_number: 'abc', bank_code: '058' }), res1);
    expect(res1.status).toHaveBeenCalledWith(400);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();

    const res2 = makeRes();
    await handler(req({ account_number: '0123456789' }), res2);
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('12. existing Paystack success/error handling is unchanged when allowed through', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const fn = vi.fn(async () => ({ ok: true, json: async () => ({ status: false, message: 'Could not resolve account' }) } as any));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: 'Could not resolve account' });
    vi.unstubAllGlobals();
  });

  it('13. response shape/status for the allowed success path is unchanged', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makePaystackFetchMock({ status: true, data: { account_name: 'Jane Doe', account_number: '0123456789' } });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account_name: 'Jane Doe', account_number: '0123456789' });
    vi.unstubAllGlobals();
  });
});
