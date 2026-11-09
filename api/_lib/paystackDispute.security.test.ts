import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// Paystack charge.dispute.* -> place_payment_dispute_hold (0203). Real
// signed requests through the real handler; the database is mocked. The
// dispute payload shape is unverified (see api/webhook/paystack.ts), so
// these tests pin the defensive behaviour: every candidate reference is
// passed, nothing is lost, and a DB failure asks Paystack to retry.

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

import handler, { disputeReferenceCandidates } from '../webhook/paystack';

const SECRET = 'sk_test_webhook_secret';

function signatureFor(rawBody: string | Buffer): string {
  return crypto.createHmac('sha512', SECRET).update(rawBody).digest('hex');
}

function makeWebhookReq(rawBody: string | Buffer) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const req: any = Readable.from([buf]);
  req.method = 'POST';
  req.headers = { 'x-paystack-signature': signatureFor(buf) };
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
});


async function send(body: unknown, sign = true) {
  const raw = JSON.stringify(body);
  const req = makeWebhookReq(raw);
  if (!sign) req.headers['x-paystack-signature'] = 'bad';
  const res = makeRes();
  await handler(req, res);
  return res;
}
const holdCalls = () => mockCallProjectAdminRpc.mock.calls.filter((c: any[]) => c[0] === 'place_payment_dispute_hold');

describe('Paystack dispute webhooks', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('charge.dispute.create: passes every candidate reference, the dispute id and the event', async () => {
    mockCallProjectAdminRpc.mockResolvedValue('held');
    const res = await send({ event: 'charge.dispute.create', data: { id: 123, reference: 'DSPREF', transaction: { reference: 'VNT-abc' }, transaction_reference: 'VNT-abc' } });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(holdCalls()).toEqual([['place_payment_dispute_hold', [['VNT-abc', 'DSPREF'], '123', 'charge.dispute.create']]]);
  });

  it('works when only transaction_reference is present', async () => {
    mockCallProjectAdminRpc.mockResolvedValue('held');
    await send({ event: 'charge.dispute.remind', data: { id: 9, transaction_reference: 'BK-1' } });
    expect(holdCalls()[0][1]).toEqual([['BK-1'], '9', 'charge.dispute.remind']);
  });

  it('charge.dispute.resolve is routed too (the database only records it; it never lifts a hold)', async () => {
    mockCallProjectAdminRpc.mockResolvedValue('resolution_recorded');
    await send({ event: 'charge.dispute.resolve', data: { id: 9, transaction: { reference: 'VNT-abc' }, resolution: 'merchant-accepted' } });
    expect(holdCalls()[0][1]).toEqual([['VNT-abc'], '9', 'charge.dispute.resolve']);
  });

  it('a dispute with no usable reference is acknowledged without a database call', async () => {
    const res = await send({ event: 'charge.dispute.create', data: { id: 5, transaction: {} } });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(holdCalls()).toHaveLength(0);
  });

  it('a database failure returns 500 so Paystack retries (the hold is idempotent)', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection reset'));
    const res = await send({ event: 'charge.dispute.create', data: { id: 1, transaction: { reference: 'VNT-abc' } } });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ received: false });
  });

  it('a forged (unsigned) dispute event is rejected before any database call', async () => {
    const res = await send({ event: 'charge.dispute.create', data: { id: 1, transaction: { reference: 'VNT-abc' } } }, false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(holdCalls()).toHaveLength(0);
  });

  it('candidate extraction: strings only, trimmed, de-duplicated, most specific first', () => {
    expect(disputeReferenceCandidates({ reference: ' X ', transaction: { reference: 'X' }, transaction_reference: 42 })).toEqual(['X']);
    expect(disputeReferenceCandidates(null)).toEqual([]);
  });
});
