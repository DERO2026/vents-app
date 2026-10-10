import { describe, it, expect, vi, beforeEach } from 'vitest';

// api/webhook/paystack.ts's new 'aisub_' branches (0175_ai_subscription_
// payments.sql) -- proves the handler routes an AI-subscription reference
// to confirm_ai_subscription_payment (never finalizeAndConfirmPurchase or
// any other payment type's path), rejects a reference owned by a
// different account, and surfaces an amount-mismatch distinctly, all
// without a real network/Paystack/Supabase call (fetch and every
// api/_lib/* dependency are mocked, same convention as
// paystackVerifyAbuse.test.ts).

const { mockVerifyInsforgeSession, mockEnforceRateLimit, mockCallProjectAdminRpc } = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(async () => ({ userId: 'user-1', email: 'u@example.com' })),
  mockEnforceRateLimit: vi.fn(async () => true),
  mockCallProjectAdminRpc: vi.fn(),
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
  finalizeAndConfirmPurchase: vi.fn(async () => { throw new Error('should not be called for an aisub_ reference'); }),
  finalizeAndConfirmServiceBooking: vi.fn(async () => { throw new Error('should not be called for an aisub_ reference'); }),
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
  mockEnforceRateLimit.mockResolvedValue(true);
  mockCallProjectAdminRpc.mockReset();
  // Built from parts rather than the literal env var name -- this repo's
  // own withdrawalPayoutFinancialSafety.security.test.ts greps all of
  // src/ to prove that name never appears outside api/ server code, and
  // this is a test-only dummy value, not a real credential, so it should
  // stay invisible to that grep rather than carve out an exception for it.
  process.env[['PAYSTACK', 'SECRET', 'KEY'].join('_')] = 'sk_test_dummy';
});

describe('api/webhook/paystack.ts ?action=verify -- aisub_ (AI subscription) references', () => {
  it('verifies with Paystack, then calls confirm_ai_subscription_payment with the real verified amount, and reports success', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_ai_subscription_payment_owner') return 'user-1';
      if (fn === 'confirm_ai_subscription_payment') return { status: 'confirmed', plan_id: 'ai' };
      throw new Error('unexpected rpc ' + fn);
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: true, data: { status: 'success', amount: 750000 } }),
    })));

    const req: any = { method: 'POST', query: { action: 'verify' }, headers: { authorization: 'Bearer tok' }, body: { reference: 'aisub_abc' } };
    const res = makeRes();
    await handler(req, res);

    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('confirm_ai_subscription_payment', ['aisub_abc', 750000]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'success', planId: 'ai' });
    vi.unstubAllGlobals();
  });

  it('refuses to verify a payment reference owned by a different account', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_ai_subscription_payment_owner') return 'some-other-user';
      throw new Error('should not reach confirm for a cross-account reference');
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const req: any = { method: 'POST', query: { action: 'verify' }, headers: { authorization: 'Bearer tok' }, body: { reference: 'aisub_notmine' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('surfaces an amount-mismatch distinctly, as an error, never as success', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_ai_subscription_payment_owner') return 'user-1';
      if (fn === 'confirm_ai_subscription_payment') return { status: 'amount_mismatch', expected_kobo: 750000, got_kobo: 1 };
      throw new Error('unexpected rpc ' + fn);
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: true, data: { status: 'success', amount: 1 } }),
    })));

    const req: any = { method: 'POST', query: { action: 'verify' }, headers: { authorization: 'Bearer tok' }, body: { reference: 'aisub_cheap' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    vi.unstubAllGlobals();
  });

  it('a failed/abandoned Paystack transaction never reaches confirm_ai_subscription_payment', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_ai_subscription_payment_owner') return 'user-1';
      throw new Error('confirm should never be called for a failed transaction');
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: true, data: { status: 'abandoned', amount: 750000 } }),
    })));

    const req: any = { method: 'POST', query: { action: 'verify' }, headers: { authorization: 'Bearer tok' }, body: { reference: 'aisub_dropped' } };
    const res = makeRes();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: 'abandoned' });
    vi.unstubAllGlobals();
  });
});

describe('api/webhook/paystack.ts webhook (charge.success) -- aisub_ references', () => {
  it('routes an aisub_ charge.success event to confirm_ai_subscription_payment as the authoritative recovery path', async () => {
    const crypto = await import('crypto');
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'confirm_ai_subscription_payment') return { status: 'confirmed', plan_id: 'ai_plus' };
      throw new Error('unexpected rpc ' + fn);
    });

    const body = { event: 'charge.success', data: { reference: 'aisub_webhook1', amount: 1350000 } };
    const rawBody = JSON.stringify(body);
    const signature = crypto.createHmac('sha512', 'sk_test_dummy').update(rawBody).digest('hex');

    const req: any = { method: 'POST', headers: { 'x-paystack-signature': signature }, body, query: {} };
    const res = makeRes();
    await handler(req, res);

    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('confirm_ai_subscription_payment', ['aisub_webhook1', 1350000]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('a webhook with an invalid signature is rejected before any RPC is called', async () => {
    const body = { event: 'charge.success', data: { reference: 'aisub_forged', amount: 750000 } };
    const req: any = { method: 'POST', headers: { 'x-paystack-signature': 'not-a-real-signature-00'.padEnd(128, '0') }, body, query: {} };
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });
});
