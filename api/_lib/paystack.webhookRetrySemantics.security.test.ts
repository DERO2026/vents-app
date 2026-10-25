import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// Fix: every branch of handleWebhook() used to catch its own RPC exception,
// log it, and still fall through to an unconditional 200 at the bottom of
// the function. That told Paystack the event was delivered successfully
// even when the underlying confirmation (confirm_ticket_payment,
// confirm_transfer_fee_payment, complete_organizer_payout,
// finalize_ticket_refund, etc.) never actually ran -- for a payment
// channel with no client-side `?action=verify` fallback (bank transfer,
// USSD), that could leave a paid order stuck in `pending` forever with no
// further automatic retry, even though Paystack already holds the money.
//
// Per Paystack's own webhook docs (https://paystack.com/docs/payments/webhooks/),
// a non-2xx response is retried (every 3 min for the first 4 tries, then
// hourly for 72h in live mode); a 2xx is not. The fix: a genuinely thrown
// exception now yields 500 (so Paystack retries); every already-known
// terminal outcome (not_found, amount_mismatch, already_paid/
// already_credited/already_confirmed, an unrecognized event, a malformed-
// but-validly-signed body) still yields 200 exactly as before, since those
// are authoritative and retrying would not change them. No RPC call's own
// idempotency guard is touched by this fix -- these tests confirm that
// directly by asserting a "retry" of an already-successful event is still
// a 200 no-op, never a double-credit.

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

describe('webhook retry semantics: a successful confirmation acknowledges 200', () => {
  it('charge.success for a ticket purchase that confirms cleanly returns 200, received: true', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_ok_1', amount: 15000 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_ok_1' }]);
    mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'confirmed', ticketIds: ['t1'] });

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });
});

describe('webhook retry semantics: a transient DB/RPC failure returns a non-2xx so Paystack retries', () => {
  it('confirm_ticket_payment throwing (e.g. a DB error, or this repo\'s new duplicate_authoritative_fee/missing_authoritative_fee exceptions) yields 500, not 200', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_fail_1', amount: 15000 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_fail_1' }]);
    mockFinalizeAndConfirmPurchase.mockRejectedValue(new Error('duplicate_authoritative_fee: payment_ref pay_fail_1'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ received: false });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a thrown error on the transfer-fee (txf_) branch yields 500', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'txf_err1', amount: 500 } });
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });

  it('a thrown error on the service-booking (BKG-) branch yields 500', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'BKG-err1', amount: 500 } });
    mockFinalizeAndConfirmServiceBooking.mockRejectedValue(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });

  it('a thrown error on the AI subscription (aisub_) branch yields 500', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'aisub_err1', amount: 500 } });
    mockCallProjectAdminRpc.mockRejectedValue(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });

  it('a thrown error on the wallet deposit (wdep_) branch yields 500', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'wdep_err1', amount: 500 } });
    mockCallProjectAdminRpc.mockRejectedValue(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });

  it('a thrown error on transfer.success yields 500', async () => {
    const rawBody = JSON.stringify({ event: 'transfer.success', data: { transfer_code: 'TRF_err', reference: 'ref1' } });
    mockCallProjectAdminTableRpc.mockRejectedValue(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });

  it('a thrown error on refund.processed yields 500', async () => {
    const rawBody = JSON.stringify({ event: 'refund.processed', data: { id: 999 } });
    mockCallProjectAdminTableRpc.mockRejectedValue(new Error('db unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });
});

describe('webhook retry semantics: already-known terminal outcomes stay 200 (retrying would not change them)', () => {
  it('not_found stays 200', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_nf_1', amount: 1000 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([]);
    mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'not_found' });

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('amount_mismatch stays 200', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_mm_1', amount: 999 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_mm_1' }]);
    mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'amount_mismatch', expectedKobo: 1000, gotKobo: 999 });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = makeWebhookReq(rawBody);
    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    errSpy.mockRestore();
  });

  it('a malformed-but-validly-signed body stays 200 (never retried, never reaches any RPC)', async () => {
    const rawBody = 'not json at all';
    const req: any = Readable.from([Buffer.from(rawBody)]);
    req.method = 'POST';
    req.headers = { 'x-paystack-signature': signatureFor(rawBody) };
    req.query = {};
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
  });

  it('an unrecognized event type stays 200', async () => {
    const rawBody = JSON.stringify({ event: 'some.unknown.event', data: {} });
    const req = makeWebhookReq(rawBody);
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('webhook retry semantics: signature verification is untouched by this fix', () => {
  it('an invalid signature is still rejected 401, regardless of what the event body contains', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_bad_sig', amount: 1000 } });
    const req: any = Readable.from([Buffer.from(rawBody)]);
    req.method = 'POST';
    req.headers = { 'x-paystack-signature': 'deadbeef'.repeat(16) };
    req.query = {};
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
  });
});

describe('webhook retry semantics: a retried event that already succeeded is still idempotent (no double-credit)', () => {
  it('re-delivering an event whose underlying RPC is idempotent (already_paid-equivalent) still returns 200 and never calls the RPC a mismatched/extra time per delivery', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_retry_1', amount: 15000 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_retry_1' }]);
    // Simulates confirm_ticket_payment's own idempotency guard: a second
    // delivery of the same event resolves to 'already_paid', not a second
    // wallet credit -- this fix changes nothing about that guarantee, it
    // only governs the HTTP response code.
    mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'already_paid' });

    const req1 = makeWebhookReq(rawBody);
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.status).toHaveBeenCalledWith(200);

    const req2 = makeWebhookReq(rawBody);
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(200);

    // Exactly one call per delivery -- the RPC itself (not this fix) is
    // what prevents a double-credit; this just confirms the fix doesn't
    // introduce a duplicate call or a duplicate credit path of its own.
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenCalledTimes(2);
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenNthCalledWith(1, 'pay_retry_1', 15000);
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenNthCalledWith(2, 'pay_retry_1', 15000);
  });

  it('after a transient failure (500), a plain retry that now succeeds returns 200 -- demonstrating real recovery, not a permanently stuck pending order', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_recover_1', amount: 15000 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_recover_1' }]);
    mockFinalizeAndConfirmPurchase.mockRejectedValueOnce(new Error('transient db error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req1 = makeWebhookReq(rawBody);
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.status).toHaveBeenCalledWith(500); // Paystack will retry per its documented schedule

    mockFinalizeAndConfirmPurchase.mockResolvedValueOnce({ status: 'confirmed', ticketIds: ['t1'] });
    const req2 = makeWebhookReq(rawBody);
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(200); // the order is no longer stuck pending

    errSpy.mockRestore();
  });

  it('two overlapping deliveries of the same event (concurrent, not sequential) each get a response and the RPC-level guard -- not this fix -- is what prevents a double-credit', async () => {
    // This genuinely runs the handler twice concurrently via Promise.all
    // (real execution against a mocked RPC layer), not a simulation. True
    // Postgres-level lock contention from two overlapping SQL transactions
    // is NOT exercised here -- that would require a live database and is
    // explicitly out of scope for this zero-cost pass. What this proves:
    // the webhook handler itself has no shared in-memory state that could
    // let a race at the HTTP layer produce two different outcomes for the
    // same reference -- each call independently awaits its own RPC result
    // and responds based on it, exactly as a sequential call would.
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_concurrent_1', amount: 15000 } });
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_concurrent_1' }]);
    // First caller to resolve gets 'confirmed'; the second, resolving
    // slightly later, gets the RPC's own idempotency guard result -- this
    // models what confirm_ticket_payment's FOR UPDATE lock + already_paid
    // guard would do for two real overlapping deliveries.
    mockFinalizeAndConfirmPurchase
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'confirmed', ticketIds: ['t1'] }), 5)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ status: 'already_paid' }), 10)));

    const req1 = makeWebhookReq(rawBody);
    const res1 = makeRes();
    const req2 = makeWebhookReq(rawBody);
    const res2 = makeRes();

    await Promise.all([handler(req1, res1), handler(req2, res2)]);

    expect(res1.status).toHaveBeenCalledWith(200);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenCalledTimes(2);
  });
});

describe('webhook retry semantics: the client-triggered ?action=verify path is unaffected (not in scope of this fix)', () => {
  it('still returns its own existing error codes unchanged (500 on a thrown error, via its own try/catch, not the flag added to handleWebhook)', async () => {
    const raw = Buffer.from(JSON.stringify({ reference: 'ref1' }));
    const req: any = Readable.from([raw]);
    req.method = 'POST';
    req.headers = { authorization: 'Bearer tok' };
    req.query = { action: 'verify' };
    mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
    mockEnforceRateLimit.mockResolvedValue(true);
    mockCallProjectAdminTableRpc.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = makeRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    errSpy.mockRestore();
  });
});
