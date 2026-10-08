import { describe, it, expect, vi, beforeEach } from 'vitest';

// Paystack financial-exposure audit finding: admin-payout-action.ts's
// existing payout_approve:<adminUserId> limit (20/hour/admin, added
// earlier this engagement) caps one admin's own rate, but nothing capped
// AGGREGATE approval volume across all admins combined. These tests prove
// the new payout_approve_global gate (100/hr) is checked AFTER the
// existing per-admin limit, still strictly before the atomic payout claim
// and the Paystack transfer, fails closed on any error, and never
// replaces or weakens the per-admin limit, the atomic claim, or admin
// authorization.

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
  const paystackCalls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    if (url.includes('admin_claim_payout_for_processing')) {
      return {
        ok: true,
        json: async () => ([{
          request_id: 'req-1', organizer_id: 'org-1', amount_kobo: 50000,
          recipient_code: 'RCP_abc', status: 'processing', claimed: true,
        }]),
      } as any;
    }
    if (url.includes('api.paystack.co/transfer')) {
      paystackCalls.push(url);
      return { ok: true, json: async () => ({ status: true, data: { transfer_code: 'TRF_1' } }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  });
  return { fn, paystackCalls };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'admin-1', email: 'admin@example.com' });
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

describe('admin-payout-action: existing per-admin limit still works', () => {
  it('the existing payout_approve:<adminId> limit still rejects on its own, independent of the global check', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string, args: any[]) => {
      if (fnName === 'check_rate_limit' && args[0] === 'payout_approve:admin-1') throw new Error('rate_limited');
      return undefined; // global check would have passed
    });
    const { fn, paystackCalls } = makeSupabaseFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(paystackCalls.length).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('admin-payout-action: global approval ceiling', () => {
  it('under the global 100/hour limit, approval proceeds to Paystack', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn, paystackCalls } = makeSupabaseFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['payout_approve:admin-1', 20, 3600]);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['payout_approve_global', 100, 3600]);
    expect(paystackCalls.length).toBe(1);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('global 100/hour reached rejects with 429 even though the per-admin limit would have passed', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string, args: any[]) => {
      if (fnName === 'check_rate_limit' && args[0] === 'payout_approve_global') throw new Error('rate_limited');
      return undefined;
    });
    const { fn, paystackCalls } = makeSupabaseFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(paystackCalls.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('a global-limit RPC/infra failure (not a genuine hit) also fails CLOSED, and never calls Paystack', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string, args: any[]) => {
      if (fnName === 'check_rate_limit' && args[0] === 'payout_approve_global') throw new Error('connection terminated');
      return undefined;
    });
    const { fn, paystackCalls } = makeSupabaseFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(paystackCalls.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('the existing atomic payout claim remains intact -- claimed:false still 409s regardless of rate limits', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const fn = vi.fn(async (url: string) => {
      if (url.includes('admin_claim_payout_for_processing')) {
        return { ok: true, json: async () => ([{ request_id: 'req-1', status: 'processing', claimed: false }]) } as any;
      }
      if (url.includes('api.paystack.co')) return { ok: true, json: async () => ({ status: true, data: {} }) } as any;
      return { ok: true, json: async () => ({}) } as any;
    });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(409);
    vi.unstubAllGlobals();
  });

  it('existing admin authorization is preserved -- the claim RPC itself still enforces is_admin()', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const fn = vi.fn(async (url: string) => {
      if (url.includes('admin_claim_payout_for_processing')) {
        return { ok: false, status: 403, json: async () => ({ message: 'Admin access required' }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(APPROVE_BODY), res);
    expect(res.status).toHaveBeenCalledWith(403);
    vi.unstubAllGlobals();
  });
});
