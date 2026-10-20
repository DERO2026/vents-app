import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// Regression coverage for audit finding F17: the webhook's HMAC-SHA512
// signature used to be verified against JSON.stringify(req.body) -- a
// re-serialization of whatever Vercel's default body parser produced, not
// the genuine bytes Paystack actually signed. A pretty-printed/whitespace-
// formatted payload (exactly how Paystack's real webhook deliveries look)
// round-trips through JSON.parse -> JSON.stringify into a DIFFERENT byte
// string, which would have made a perfectly legitimate webhook fail
// signature verification under the old code. The fix disables Vercel's
// automatic body parsing (config.api.bodyParser = false) and reads the raw
// request bytes directly, verifying against those bytes before any JSON
// parsing happens.
//
// req is simulated as a genuine Node.js Readable stream (via Readable.from)
// in every test below, not a plain object with a pre-set .body -- this
// exercises the real readRawBody() stream-draining logic exactly as
// production does, so these tests cannot be satisfied by a mock that
// bypasses the signature-verification code path.

const {
  mockFinalizeAndConfirmPurchase,
  mockFinalizeAndConfirmServiceBooking,
  mockCallProjectAdminRpc,
  mockCallProjectAdminTableRpc,
  mockVerifyInsforgeSession,
  mockEnforceRateLimit,
  mockApplyCors,
  mockDeliverPendingPushesForUser,
  mockSendPayoutDecisionEmail,
  mockSendTicketRefundEmail,
} = vi.hoisted(() => ({
  mockFinalizeAndConfirmPurchase: vi.fn(),
  mockFinalizeAndConfirmServiceBooking: vi.fn(),
  mockCallProjectAdminRpc: vi.fn(),
  mockCallProjectAdminTableRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockApplyCors: vi.fn(),
  mockDeliverPendingPushesForUser: vi.fn(),
  mockSendPayoutDecisionEmail: vi.fn(),
  mockSendTicketRefundEmail: vi.fn(),
}));

vi.mock('./mailer.js', () => ({
  sendPayoutDecisionEmail: mockSendPayoutDecisionEmail,
  sendTicketRefundEmail: mockSendTicketRefundEmail,
}));
vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
  callProjectAdminTableRpc: mockCallProjectAdminTableRpc,
}));
vi.mock('./finalizePaystackPayment.js', () => ({
  finalizeAndConfirmPurchase: mockFinalizeAndConfirmPurchase,
  finalizeAndConfirmServiceBooking: mockFinalizeAndConfirmServiceBooking,
}));
vi.mock('./verifyAuth.js', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
}));
vi.mock('./cors.js', () => ({ applyCors: mockApplyCors }));
vi.mock('./pushDelivery.js', () => ({ deliverPendingPushesForUser: mockDeliverPendingPushesForUser }));

import handler from '../webhook/paystack';

const SECRET = 'sk_test_webhook_secret';

function signatureFor(rawBody: string | Buffer): string {
  return crypto.createHmac('sha512', SECRET).update(rawBody).digest('hex');
}

// Builds a real Node.js Readable (http.IncomingMessage stand-in) carrying
// the given raw bytes, with the extra properties the handler reads
// (method/headers/query) attached directly to it -- genuinely async-
// iterable, exactly like the real request object readRawBody() drains.
function makeWebhookReq(rawBody: string | Buffer, { signature, method = 'POST' }: { signature?: string; method?: string } = {}) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const req: any = Readable.from([buf]);
  req.method = method;
  req.headers = signature !== undefined ? { 'x-paystack-signature': signature } : {};
  req.query = {};
  return req;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'confirmed', ticketIds: ['t1'] });
});

describe('F17: webhook signature is verified against the genuine raw bytes, not a re-serialization', () => {
  it('a pretty-printed payload (real-world Paystack formatting) with a valid raw-body signature is accepted, even though JSON.stringify(JSON.parse(payload)) produces different bytes', async () => {
    const rawBody =
      '{\n  "event": "charge.success",\n  "data": {\n    "reference": "ref-raw-1",\n    "amount": 1000\n  }\n}';
    const signature = signatureFor(rawBody);

    // Prove the premise: the old code's approach (signing JSON.stringify of
    // the parsed object) would NOT have matched this real signature --
    // demonstrating the regression this fix closes, without needing to
    // reinstate the removed vulnerable code path.
    const oldApproachBytes = JSON.stringify(JSON.parse(rawBody));
    expect(oldApproachBytes).not.toBe(rawBody);
    const oldApproachSignature = signatureFor(oldApproachBytes);
    expect(oldApproachSignature).not.toBe(signature);

    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'ref-raw-1' }]);

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenCalledWith('ref-raw-1', 1000);
  });

  it('a compact (no whitespace) payload still verifies correctly -- the fix does not depend on formatting one way or the other', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-compact-1', amount: 2500 } });
    const signature = signatureFor(rawBody);
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'ref-compact-1' }]);

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenCalledWith('ref-compact-1', 2500);
  });
});

describe('F17: invalid signature is rejected', () => {
  it('a forged/incorrect signature is rejected with 401, and no RPC is ever called', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-forged', amount: 5000 } });
    const forgedSignature = signatureFor('{"event":"something else entirely"}');

    const req = makeWebhookReq(rawBody, { signature: forgedSignature });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('a missing signature header is rejected with 400 before any body processing', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-nosig', amount: 1000 } });
    const req = makeWebhookReq(rawBody); // no signature key set at all
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing signature' });
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
  });

  it('a malformed (non-hex) signature header is rejected, not thrown as an unhandled error', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-badhex', amount: 1000 } });
    const req = makeWebhookReq(rawBody, { signature: 'not-valid-hex!!' });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
  });
});

describe('F17: a correctly signed, valid webhook still reaches the expected existing RPC path', () => {
  it('charge.success for a ticket purchase resolves the payment_ref and calls finalizeAndConfirmPurchase, returning 200', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_ref_123', amount: 15000 } });
    const signature = signatureFor(rawBody);
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_ref_123' }]);
    mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'confirmed', ticketIds: ['tk-1', 'tk-2'] });

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(mockFinalizeAndConfirmPurchase).toHaveBeenCalledWith('pay_ref_123', 15000);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('charge.success for a transfer-fee reference (txf_ prefix) calls confirm_transfer_fee_payment, not finalizeAndConfirmPurchase', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'txf_abc123', amount: 500 } });
    const signature = signatureFor(rawBody);
    mockCallProjectAdminRpc.mockResolvedValue('confirmed');

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('confirm_transfer_fee_payment', ['txf_abc123', 500]);
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('transfer.success calls complete_organizer_payout via the project-admin table RPC', async () => {
    const rawBody = JSON.stringify({ event: 'transfer.success', data: { transfer_code: 'TRF_1', reference: 'ref1' } });
    const signature = signatureFor(rawBody);
    mockCallProjectAdminTableRpc.mockResolvedValue([{ status: 'completed' }]);

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(mockCallProjectAdminTableRpc).toHaveBeenCalledWith('complete_organizer_payout', ['TRF_1']);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('F17: malformed body is rejected safely without triggering unintended payment processing', () => {
  it('a validly-signed but non-JSON body is accepted at the signature layer but never reaches any RPC, and still returns 200 (so Paystack does not endlessly retry)', async () => {
    const rawBody = 'this is not json at all';
    const signature = signatureFor(rawBody); // genuinely valid signature over these exact (malformed) bytes

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
  });

  it('charge.success missing reference/amount is a safe no-op, not a crash', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: {} });
    const signature = signatureFor(rawBody);

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
  });

  it('an unrecognized event type is a safe no-op, acknowledged with 200', async () => {
    const rawBody = JSON.stringify({ event: 'some.unknown.event', data: {} });
    const signature = signatureFor(rawBody);

    const req = makeWebhookReq(rawBody, { signature });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });
});

describe('F17: existing safeguards on the client-triggered verify path are preserved by the same raw-body change', () => {
  function makeVerifyReq(body: any, { query = { action: 'verify' }, authorization = 'Bearer tok' } = {}) {
    const raw = Buffer.from(JSON.stringify(body));
    const req: any = Readable.from([raw]);
    req.method = 'POST';
    req.headers = { authorization };
    req.query = query;
    return req;
  }

  beforeEach(() => {
    mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
    mockEnforceRateLimit.mockResolvedValue(true);
  });

  it('still requires authentication before touching the body at all', async () => {
    mockVerifyInsforgeSession.mockResolvedValue(null);
    const req = makeVerifyReq({ reference: 'ref1' });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
  });

  it('still rejects a request with no reference field, same as before', async () => {
    const req = makeVerifyReq({});
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('a malformed JSON body on the verify path is rejected with 400, not a 500 or an unhandled throw', async () => {
    const raw = Buffer.from('{not valid json');
    const req: any = Readable.from([raw]);
    req.method = 'POST';
    req.headers = { authorization: 'Bearer tok' };
    req.query = { action: 'verify' };
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Malformed JSON body' });
    expect(mockVerifyInsforgeSession).not.toHaveBeenCalled();
  });

  it('a well-formed, authenticated verify request for an unowned reference is still rejected with 403 (ownership check intact)', async () => {
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'ref1', owner_id: 'someone-else', payer_id: null }]);
    const req = makeVerifyReq({ reference: 'ref1' });
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
