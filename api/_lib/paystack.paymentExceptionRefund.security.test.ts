import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// AZ-10 (migration 0234): Paystack's refund.processed / refund.failed for a
// two-admin refund of a payment captured without a ticket. It is the last
// link of the existing refund chain (ticket -> transfer fee -> service
// booking -> payment exception). Before 0234 is applied the functions don't
// exist: that must read as "not found" (200, no Paystack retry loop), while
// any other database error must still be a 500 so Paystack retries.
// AZ-08 (migration 0233): a duplicate transfer-fee payment is recorded by
// the database and must never trigger the automatic transfer-fee refund.

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


const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const notFoundRow = [{ status: 'not_found' }];

async function deliver(event: object) {
  const req = makeWebhookReq(JSON.stringify(event));
  const res = makeRes();
  await handler(req, res);
  return res;
}

describe('refund webhooks reach two-admin payment-exception refunds (0234)', () => {
  it('refund.processed: after ticket, transfer-fee and booking refunds all say not_found, the payment exception is finalized', async () => {
    mockCallProjectAdminTableRpc.mockImplementation(async (fn: string) =>
      fn === 'finalize_payment_exception_refund' ? [{ status: 'finalized', buyer_email: 'b@example.com', buyer_name: 'B', amount_kobo: 1000 }] : notFoundRow);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await deliver({ event: 'refund.processed', data: { id: 4242 } });
    const order = mockCallProjectAdminTableRpc.mock.calls.map(([fn]) => fn);
    expect(order).toEqual(['finalize_ticket_refund', 'finalize_transfer_fee_refund', 'finalize_service_booking_refund', 'finalize_payment_exception_refund']);
    expect(mockCallProjectAdminTableRpc).toHaveBeenLastCalledWith('finalize_payment_exception_refund', ['4242']);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refund.processed for a ticket refund never touches payment exceptions', async () => {
    mockCallProjectAdminTableRpc.mockResolvedValue([{ status: 'finalized' }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliver({ event: 'refund.processed', data: { id: 77 } });
    expect(mockCallProjectAdminTableRpc.mock.calls.map(([fn]) => fn)).toEqual(['finalize_ticket_refund']);
  });

  it('refund.failed: the payment exception failure is recorded last in the chain', async () => {
    mockCallProjectAdminTableRpc.mockResolvedValue(notFoundRow);
    mockCallProjectAdminRpc.mockImplementation(async (fn: string) => (fn === 'fail_payment_exception_refund' ? 'failed_recorded' : 'not_found'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await deliver({ event: 'refund.failed', data: { id: 5151, message: 'bank rejected' } });
    expect(mockCallProjectAdminRpc).toHaveBeenLastCalledWith('fail_payment_exception_refund', ['5151', 'bank rejected']);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('before 0234 is applied (undefined function 42883) an unmatched refund event is still a 200, not a retry loop', async () => {
    mockCallProjectAdminTableRpc.mockImplementation(async (fn: string) => {
      if (fn === 'finalize_payment_exception_refund') throw pgError('42883', 'function public.finalize_payment_exception_refund(text) does not exist');
      return notFoundRow;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await deliver({ event: 'refund.processed', data: { id: 9001 } });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('any other database error on the payment-exception step is a 500 so Paystack retries', async () => {
    mockCallProjectAdminTableRpc.mockImplementation(async (fn: string) => {
      if (fn === 'finalize_payment_exception_refund') throw pgError('08006', 'connection failure');
      return notFoundRow;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await deliver({ event: 'refund.processed', data: { id: 9002 } });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('a duplicate transfer-fee payment (0233) is never auto-refunded', () => {
  it('confirm_transfer_fee_payment -> duplicate_payment: 200, no Paystack refund call, no refund bookkeeping', async () => {
    mockCallProjectAdminRpc.mockResolvedValue('duplicate_payment');
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: true, json: async () => ({}) } as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await deliver({ event: 'charge.success', data: { reference: 'txf_dup123', amount: 75000 } });
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('confirm_transfer_fee_payment', ['txf_dup123', 75000]);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('api.paystack.co/refund'))).toBe(false);
    expect(mockCallProjectAdminRpc.mock.calls.map(([fn]) => fn)).not.toContain('attach_transfer_fee_refund_id');
    expect(res.status).toHaveBeenCalledWith(200);
    fetchSpy.mockRestore();
  });
});
