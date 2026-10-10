import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wallet "Add Bank Account: Too Many Requests" investigation.
//
// Root cause found by direct inspection: this endpoint's rate-limit check
// used a blanket `catch { return 429 'Too many requests' }` around
// check_rate_limit() -- so a GENUINE rate-limit hit (check_rate_limit's
// own `RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0429'`, confirmed
// live against the production function definition) and ANY OTHER failure
// (a missing PROJECT_ADMIN_DATABASE_URL, a dropped Postgres connection,
// any unrelated error from callProjectAdminRpc) were reported to the user
// as the exact same "Too many requests. Please try again in a bit."
// message. A user hitting an infra/config problem on every single call
// would see that message every time and reasonably describe it as
// "repeatedly" rate-limited, when request volume was never the cause.
//
// Ruled out directly against the live production database before writing
// this fix (not assumed): the rate-limit key IS scoped per real,
// server-verified user id (verifyInsforgeSession reads a real uuid from
// Supabase's own /auth/v1/user, never shared across users); the window
// resets correctly on real calendar-hour boundaries (check_rate_limit's
// own floor(epoch/window) math, confirmed by calling it live in a
// rolled-back transaction); project_admin has real EXECUTE+table grants
// for check_rate_limit/rate_limits (confirmed live); the unique index
// check_rate_limit's ON CONFLICT relies on exists (confirmed live). None
// of those were broken. The blanket catch was the one real, reproducible
// defect -- these tests pin the fix: a genuine rate_limited exception
// (err.code === 'P0429') still returns 429, but any OTHER error now
// returns 503 with an honest message, never claiming "too many requests"
// for something that wasn't that.
//
// This still fails CLOSED either way (the Paystack call never happens on
// either error path) -- see resolve-account.ts's own comment for why that
// property is deliberately preserved, not relaxed.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
}));

vi.mock('../_lib/projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('../_lib/verifyAuth.js', () => ({ verifyInsforgeSession: mockVerifyInsforgeSession }));
vi.mock('../_lib/cors.js', () => ({ applyCors: vi.fn() }));

import handler from './resolve-account';

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

const VALID_BODY = { account_number: '0123456789', bank_code: '058' };

function makePaystackFetchMock(ok = true) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    return { ok, status: ok ? 200 : 422, json: async () => (ok ? { status: true, data: { account_name: 'Test Person', account_number: '0123456789' } } : { status: false, message: 'Could not resolve account' }) } as any;
  });
  return { fn, calls };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
});

describe('wallet/resolve-account: accurate error classification (the actual "too many requests" bug)', () => {
  it('1. a first-time, valid request succeeds and calls Paystack exactly once', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn, calls } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_resolve_account:user-1', 30, 3600]);
    expect(calls.filter((u) => u.includes('api.paystack.co')).length).toBe(1);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('5. a genuine VENTS rate limit (check_rate_limit raises P0429) returns 429 "Too many requests" and never calls Paystack', async () => {
    const err: any = new Error('rate_limited');
    err.code = 'P0429';
    mockCallProjectAdminRpc.mockRejectedValue(err);
    const { fn, calls } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'Too many requests. Please try again in a bit.' });
    expect(calls.some((u) => u.includes('api.paystack.co'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('this is THE bug: an unrelated infra/config failure (not a real rate-limit hit) must NOT be reported as "Too many requests"', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('PROJECT_ADMIN_DATABASE_URL not set'));
    const { fn, calls } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    // Still fails closed (Paystack never called)...
    expect(calls.some((u) => u.includes('api.paystack.co'))).toBe(false);
    // ...but must not claim this was a rate limit.
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).not.toHaveBeenCalledWith({ error: 'Too many requests. Please try again in a bit.' });
    vi.unstubAllGlobals();
  });

  it('a dropped Postgres connection (generic error, no .code) is also never misreported as a rate limit', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    const { fn } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(503);
    vi.unstubAllGlobals();
  });

  it('4. Paystack\'s own throttling (their HTTP 429) is reported distinctly from both VENTS\'s rate limit and "invalid account"', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const fn = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ status: false, message: 'Rate limit exceeded' }) }));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).not.toBe('Too many requests. Please try again in a bit.');
    expect(payload.error).not.toContain('check the number and bank');
    vi.unstubAllGlobals();
  });

  it('10. invalid bank details return a distinct 422, not a rate-limit or provider-outage message', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makePaystackFetchMock(false);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY), res);
    expect(res.status).toHaveBeenCalledWith(422);
    vi.unstubAllGlobals();
  });

  it('6. after a genuine rate-limit rejection, a retry that is actually within the window succeeds normally', async () => {
    const err: any = new Error('rate_limited');
    err.code = 'P0429';
    mockCallProjectAdminRpc.mockRejectedValueOnce(err).mockResolvedValueOnce(undefined);
    const { fn } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);

    const res1 = makeRes();
    await handler(req(VALID_BODY), res1);
    expect(res1.status).toHaveBeenCalledWith(429);

    const res2 = makeRes();
    await handler(req(VALID_BODY), res2);
    expect(res2.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('8. an unauthenticated caller never reaches the rate-limit check or Paystack at all', async () => {
    mockVerifyInsforgeSession.mockResolvedValue(null);
    const { fn } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(VALID_BODY, 'Bearer invalid'), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('two different users never share the rate-limit key (keyed per real, server-verified user id)', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makePaystackFetchMock(true);
    vi.stubGlobal('fetch', fn);

    mockVerifyInsforgeSession.mockResolvedValueOnce({ userId: 'user-A', email: 'a@example.com' });
    await handler(req(VALID_BODY), makeRes());
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_resolve_account:user-A', 30, 3600]);

    mockVerifyInsforgeSession.mockResolvedValueOnce({ userId: 'user-B', email: 'b@example.com' });
    await handler(req(VALID_BODY), makeRes());
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_resolve_account:user-B', 30, 3600]);
    vi.unstubAllGlobals();
  });
});
