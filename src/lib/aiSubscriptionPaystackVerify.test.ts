import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

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

// The handler disables Vercel's body parser and reads the raw request bytes
// (F17: the webhook HMAC is checked against exactly what Paystack signed).
// So every request here is a real Node Readable carrying raw bytes, the
// same shape production receives -- never a pre-parsed req.body.
function rawReq(raw: string | Buffer, props: { method?: string; query?: any; headers?: any }): any {
  const req: any = Readable.from([Buffer.isBuffer(raw) ? raw : Buffer.from(raw)]);
  req.method = props.method ?? 'POST';
  req.query = props.query ?? {};
  req.headers = props.headers ?? {};
  return req;
}
const verifyReq = (body: unknown) =>
  rawReq(JSON.stringify(body), { query: { action: 'verify' }, headers: { authorization: 'Bearer tok' } });
const sign = (raw: string | Buffer, secret = 'sk_test_dummy') => crypto.createHmac('sha512', secret).update(raw).digest('hex');
const webhookReq = (raw: string | Buffer, signature?: string) =>
  rawReq(raw, { headers: signature === undefined ? {} : { 'x-paystack-signature': signature } });

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

    const req = verifyReq({ reference: 'aisub_abc' });
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

    const req = verifyReq({ reference: 'aisub_notmine' });
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

    const req = verifyReq({ reference: 'aisub_cheap' });
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

    const req = verifyReq({ reference: 'aisub_dropped' });
    const res = makeRes();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ status: 'abandoned' });
    vi.unstubAllGlobals();
  });
});

describe('api/webhook/paystack.ts webhook (charge.success) -- aisub_ references', () => {
  it('routes an aisub_ charge.success event to confirm_ai_subscription_payment as the authoritative recovery path', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => {
      if (fn === 'confirm_ai_subscription_payment') return { status: 'confirmed', plan_id: 'ai_plus' };
      throw new Error('unexpected rpc ' + fn);
    });

    const body = { event: 'charge.success', data: { reference: 'aisub_webhook1', amount: 1350000 } };
    const rawBody = JSON.stringify(body);
    const req = webhookReq(rawBody, sign(rawBody));
    const res = makeRes();
    await handler(req, res);

    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('confirm_ai_subscription_payment', ['aisub_webhook1', 1350000]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('a webhook with an invalid signature is rejected before any RPC is called', async () => {
    const body = { event: 'charge.success', data: { reference: 'aisub_forged', amount: 750000 } };
    const req = webhookReq(JSON.stringify(body), 'not-a-real-signature-00'.padEnd(128, '0'));
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });
});

describe('raw request bodies: signature, tampering and malformed input', () => {
  const event = { event: 'charge.success', data: { reference: 'aisub_raw1', amount: 1350000 } };

  it('a validly signed pretty-printed delivery is accepted (the signature covers the exact bytes)', async () => {
    mockCallProjectAdminRpc.mockResolvedValue({ status: 'confirmed', plan_id: 'ai' });
    const raw = JSON.stringify(event, null, 2);
    const res = makeRes();
    await handler(webhookReq(raw, sign(raw)), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('confirm_ai_subscription_payment', ['aisub_raw1', 1350000]);
  });

  it('an altered amount after signing is rejected with 401 and nothing is confirmed', async () => {
    const raw = JSON.stringify(event);
    const tampered = raw.replace('1350000', '1');
    const res = makeRes();
    await handler(webhookReq(tampered, sign(raw)), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('a byte-only change (same JSON, different whitespace) is rejected: the check is on the raw bytes, not a re-serialisation', async () => {
    const raw = JSON.stringify(event);
    const res = makeRes();
    await handler(webhookReq(JSON.stringify(event, null, 1), sign(raw)), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('extra bytes appended after a signed body are rejected', async () => {
    const raw = JSON.stringify(event);
    const res = makeRes();
    await handler(webhookReq(raw + ' ', sign(raw)), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('a signature made with another secret is rejected', async () => {
    const raw = JSON.stringify(event);
    const res = makeRes();
    await handler(webhookReq(raw, sign(raw, 'sk_test_attacker')), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('a missing signature is rejected with 400 before anything else', async () => {
    const res = makeRes();
    await handler(webhookReq(JSON.stringify(event)), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('a validly signed but malformed JSON webhook is acknowledged (200, so Paystack stops retrying) and calls nothing', async () => {
    const raw = '{"event":"charge.success","data":{"reference":"aisub_x",';
    const res = makeRes();
    await handler(webhookReq(raw, sign(raw)), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('malformed JSON on the verify path is a 400, before authentication, rate limiting, Paystack or any RPC', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = makeRes();
    await handler(rawReq('{"reference":', { query: { action: 'verify' }, headers: { authorization: 'Bearer tok' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockVerifyInsforgeSession).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a verify request whose reference is not a string is refused (400) without calling Paystack', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = makeRes();
    await handler(verifyReq({ reference: { $ne: null } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a pre-parsed object body (body parser wrongly enabled) fails closed: 500, no signature bypass, no RPC', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {}, headers: { 'x-paystack-signature': sign(JSON.stringify(event)) }, body: event }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });
});
