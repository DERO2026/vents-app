import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 2 cost-hardening: dynamic proof (not just static-analysis, see
// paystackVerifyRateLimit.security.test.ts) that repeatedly calling the
// client-triggered Paystack verify endpoint stops hitting Paystack's real
// API once the existing 30/hour/user enforceRateLimit cap (added in the
// MEDIUM #1 fix) is exceeded. No real network call is made -- `fetch` is
// mocked throughout, and the assertion is on how many times it was called.

const { mockVerifyInsforgeSession, mockEnforceRateLimit, mockCallProjectAdminRpc } = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(async () => ({ userId: 'user-1', email: 'u@example.com' })),
  mockEnforceRateLimit: vi.fn(),
  mockCallProjectAdminRpc: vi.fn(async () => ({})),
}));

vi.mock('../../api/_lib/verifyAuth.js', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
}));
vi.mock('../../api/_lib/cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/mailer.js', () => ({ sendPayoutDecisionEmail: vi.fn(), sendTicketRefundEmail: vi.fn() }));
vi.mock('../../api/_lib/projectAdminDb.js', () => ({
  callProjectAdminTableRpc: vi.fn(async () => []),
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('../../api/_lib/finalizePaystackPayment.js', () => ({
  finalizeAndConfirmPurchase: vi.fn(async () => ({})),
  finalizeAndConfirmServiceBooking: vi.fn(async () => ({})),
}));
vi.mock('../../api/_lib/pushDelivery.js', () => ({ deliverPendingPushesForUser: vi.fn(async () => ({ sent: 0, total: 0 })) }));

import handler from '../../api/webhook/paystack';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

beforeEach(() => {
  mockVerifyInsforgeSession.mockClear();
  mockEnforceRateLimit.mockReset();
});

describe('Paystack ?action=verify under repeated calls (real-world: a client retry loop)', () => {
  it('100 repeated calls: real Paystack fetch stops the moment enforceRateLimit says no, never exceeding the allowed window', async () => {
    // Mirrors what the real check_rate_limit RPC does: allow the first 30
    // calls in the window, reject every call after that.
    let count = 0;
    mockEnforceRateLimit.mockImplementation(async () => { count++; return count <= 30; });

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: true, data: { status: 'success', amount: 100000, reference: 'ref', metadata: {} } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) {
      const req: any = {
        method: 'POST',
        query: { action: 'verify' },
        headers: { authorization: 'Bearer tok' },
        body: { reference: `VNT-${i}` },
      };
      const res = makeRes();
      await handler(req, res);
      statuses.push(res.status.mock.calls[0][0]);
    }

    const blocked = statuses.filter((s) => s === 429).length;
    const allowed = statuses.filter((s) => s !== 429).length;
    expect(allowed).toBe(30);
    expect(blocked).toBe(70);
    // The real signal that matters for cost: Paystack's API was never
    // called more than the number of genuinely allowed attempts.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(30);

    vi.unstubAllGlobals();
  });

  it('a single rejection never leaks into calling Paystack at all', async () => {
    mockEnforceRateLimit.mockResolvedValue(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', query: { action: 'verify' }, headers: { authorization: 'Bearer tok' }, body: { reference: 'VNT-x' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
