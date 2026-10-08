import { describe, it, expect, vi, beforeEach } from 'vitest';

// Paystack payout audit finding: approving a payout
// (api/wallet/admin-payout-action.ts, action==='approve') fires a real
// Paystack transfer and is single-admin-gated (is_admin() allows role
// 'admin' or 'sub-admin') with no pacing safeguard of its own. The atomic
// claim (admin_claim_payout_for_processing) already prevents the SAME
// request from being double-transferred -- these tests cover the
// different, narrower gap this change closes: nothing previously stopped
// one admin session from approving many DIFFERENT, individually legitimate
// requests in rapid succession. Keyed per approving admin
// (payout_approve:<adminUserId>), 20/hour, calling check_rate_limit
// directly over the trusted project_admin connection so it fails CLOSED on
// ANY error -- same pattern as ticketResendRateLimit.security.test.ts /
// resolveAccountRateLimit.security.test.ts, adapted here because this
// endpoint sits directly in front of a real transfer.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: mockVerifyInsforgeSession }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./mailer.js', () => ({ sendPayoutDecisionEmail: vi.fn() }));

import handler from '../wallet/admin-payout-action';

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

const APPROVE_BODY = { action: 'approve', request_id: 'req-1' };

function makeSupabaseFetchMock() {
  const calls: { url: string; body: any }[] = [];
  const fn = vi.fn(async (url: string, opts: any) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url.includes('admin_claim_payout_for_processing')) {
      return {
        ok: true,
        json: async () => [{
          request_id: 'req-1', organizer_id: 'org-1', amount_kobo: 50000,
          recipient_code: 'RCP_abc', status: 'processing', claimed: true,
        }],
      } as any;
    }
    if (url.includes('admin_mark_payout_processing')) {
      return { ok: true, json: async () => ({}) } as any;
    }
    if (url.includes('admin_release_payout_claim')) {
      return { ok: true, json: async () => ({}) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  });
  return { fn, calls, getPaystackCalls: () => calls.filter((c) => false) };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'admin-1', email: 'admin@example.com' });
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

describe('admin-payout-action: approval rate limit', () => {
  it('1. an approval within the limit proceeds to Paystack and succeeds', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn: supabaseFetch } = makeSupabaseFetchMock();
    const paystackFetch = vi.fn(async (url: string) => {
      if (String(url).includes('api.paystack.co/transfer')) {
        return { ok: true, json: async () => ({ status: true, data: { transfer_code: 'TRF_1' } }) } as any;
      }
      return supabaseFetch(url, {});
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      if (String(url).includes('api.paystack.co')) return paystackFetch(url);
      return supabaseFetch(url, opts);
    }));
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['payout_approve:admin-1', 20, 3600]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(paystackFetch).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('2. an approval over the limit is rejected with 429 and never calls Paystack', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const paystackFetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: true, data: {} }) } as any));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('api.paystack.co')) return paystackFetch(url);
      return { ok: true, json: async () => ({}) } as any;
    }));
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(paystackFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('3. a rate-limit infrastructure failure (not a genuine limit hit) fails CLOSED, not open', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const paystackFetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: true, data: {} }) } as any));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('api.paystack.co')) return paystackFetch(url);
      return { ok: true, json: async () => ({}) } as any;
    }));
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(paystackFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('4. the rate-limit check runs before admin_claim_payout_for_processing -- a rejected check never claims the request either', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const claimFn = vi.fn(async () => ({ ok: true, json: async () => ([{ claimed: true }]) } as any));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('admin_claim_payout_for_processing')) return claimFn(url);
      return { ok: true, json: async () => ({}) } as any;
    }));
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(claimFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('5. the existing atomic duplicate-claim protection is untouched -- a claim that reports claimed:false still returns 409, not a transfer', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const paystackFetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: true, data: {} }) } as any));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('api.paystack.co')) return paystackFetch(url);
      if (String(url).includes('admin_claim_payout_for_processing')) {
        return { ok: true, json: async () => ([{ request_id: 'req-1', status: 'processing', claimed: false }]) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(paystackFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('6. different payout request ids remain independently processable under the same admin rate-limit key (limiter is per-admin, not per-request)', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const paystackFetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: true, data: { transfer_code: 'TRF_x' } }) } as any));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('api.paystack.co')) return paystackFetch(url);
      if (String(url).includes('admin_claim_payout_for_processing')) {
        return { ok: true, json: async () => ([{ request_id: 'req-x', status: 'processing', claimed: true, recipient_code: 'RCP_x', amount_kobo: 1000, organizer_id: 'org-x' }]) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));

    const res1 = makeRes();
    await handler(req({ action: 'approve', request_id: 'req-A' }), res1);
    expect(res1.status).toHaveBeenCalledWith(200);

    const res2 = makeRes();
    await handler(req({ action: 'approve', request_id: 'req-B' }), res2);
    expect(res2.status).toHaveBeenCalledWith(200);

    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['payout_approve:admin-1', 20, 3600]);
    // 2 per approval since the global payout_approve_global ceiling (added
    // in a later hardening pass) is checked right after the per-admin one.
    expect(mockCallProjectAdminRpc).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it('does not rate-limit reject/cancel actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'rejected' }) } as any)));
    const res = makeRes();
    await handler(req({ action: 'reject', request_id: 'req-1', reason: 'not eligible' }), res);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });
});
