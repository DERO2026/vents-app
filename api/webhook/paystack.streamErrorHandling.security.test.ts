import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// F17 follow-up: handler()'s await readRawBody(req) previously had no
// local try/catch, so a request stream erroring mid-read (client
// disconnect, proxy reset) escaped as an uncaught rejection instead of
// following this file's own error-handling/logging conventions. Fixed by
// wrapping the raw-body read in handler() itself, before any routing --
// a stream failure now logs a sanitized message and returns a controlled
// 500, with no signature check, JSON parse, or RPC call ever reached.
//
// req is a genuine Node.js Readable in every test below (constructed with
// `new Readable({ read() {} })` and explicitly `.destroy(err)`ed to
// trigger a real stream error), not a mock that fakes a rejection --
// this exercises the actual for-await-driven readRawBody() code path
// exactly as production does.

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

vi.mock('../_lib/mailer.js', () => ({
  sendPayoutDecisionEmail: mockSendPayoutDecisionEmail,
  sendTicketRefundEmail: mockSendTicketRefundEmail,
}));
vi.mock('../_lib/projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
  callProjectAdminTableRpc: mockCallProjectAdminTableRpc,
}));
vi.mock('../_lib/finalizePaystackPayment.js', () => ({
  finalizeAndConfirmPurchase: mockFinalizeAndConfirmPurchase,
  finalizeAndConfirmServiceBooking: mockFinalizeAndConfirmServiceBooking,
}));
vi.mock('../_lib/verifyAuth.js', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
}));
vi.mock('../_lib/cors.js', () => ({ applyCors: mockApplyCors }));
vi.mock('../_lib/pushDelivery.js', () => ({ deliverPendingPushesForUser: mockDeliverPendingPushesForUser }));

import handler from './paystack';

const SECRET = 'sk_test_webhook_secret';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}

// A genuine Readable that errors partway through, instead of ending
// normally -- `new Readable({ read() {} })` never auto-pushes EOF, so the
// stream stays open until we explicitly push a partial chunk and then
// destroy() it with an error, which is exactly how a real client
// disconnect / proxy reset surfaces to a Node http.IncomingMessage.
function makeErroringReq({ method = 'POST', signature }: { method?: string; signature?: string } = {}) {
  const req: any = new Readable({ read() {} });
  req.method = method;
  req.headers = signature !== undefined ? { 'x-paystack-signature': signature } : {};
  req.query = {};
  // Push a partial chunk first so this is genuinely a mid-read failure,
  // not an immediate one -- readRawBody must not retain or process this
  // partial data once the stream errors.
  req.push(Buffer.from('{"event":"char'));
  queueMicrotask(() => req.destroy(new Error('simulated connection reset')));
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = SECRET;
});

describe('F17 follow-up: a request stream that errors mid-read is handled safely', () => {
  it('returns a controlled 500 and logs a sanitized error message, not an uncaught rejection', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeErroringReq({ signature: 'irrelevant-because-never-reached' });
    const res = makeRes();

    // The whole point of this fix: handler() resolves normally (no
    // uncaught rejection escapes it) even though the underlying stream
    // errored -- if it threw, this await would reject and fail the test.
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Could not read request body' });

    // Logged, but never the signature header, the partial payload bytes,
    // or any secret -- only the stream error's own message.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Paystack webhook] Failed to read request body:',
      'simulated connection reset'
    );
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(' ');
    expect(loggedArgs).not.toContain('irrelevant-because-never-reached');
    expect(loggedArgs).not.toContain(SECRET);
    expect(loggedArgs).not.toContain('char'); // the partial body chunk that was pushed before the error

    consoleErrorSpy.mockRestore();
  });

  it('never reaches signature verification, JSON parsing, or any RPC/payment-processing call after a stream failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeErroringReq({ signature: 'deadbeef' });
    const res = makeRes();

    await handler(req, res);

    expect(mockFinalizeAndConfirmPurchase).not.toHaveBeenCalled();
    expect(mockFinalizeAndConfirmServiceBooking).not.toHaveBeenCalled();
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
    expect(mockSendPayoutDecisionEmail).not.toHaveBeenCalled();
    expect(mockSendTicketRefundEmail).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(401); // never got far enough to reject/accept a signature
    expect(res.status).not.toHaveBeenCalledWith(200);

    vi.restoreAllMocks();
  });

  it('a stream failure on the client-triggered ?action=verify path is also caught before any auth/body handling', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeErroringReq({ method: 'POST' });
    req.query = { action: 'verify' };
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Could not read request body' });
    expect(mockVerifyInsforgeSession).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('F17 follow-up: a normal, successfully-read request still follows the existing path unchanged', () => {
  it('a valid signed webhook with a cleanly-ending stream still verifies and dispatches to the correct RPC', async () => {
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'pay_ref_ok', amount: 9900 } });
    const signature = crypto.createHmac('sha512', SECRET).update(rawBody).digest('hex');
    mockCallProjectAdminTableRpc.mockResolvedValue([{ payment_ref: 'pay_ref_ok' }]);
    mockFinalizeAndConfirmPurchase.mockResolvedValue({ status: 'confirmed', ticketIds: ['t1'] });

    const req: any = Readable.from([Buffer.from(rawBody)]);
    req.method = 'POST';
    req.headers = { 'x-paystack-signature': signature };
    req.query = {};
    const res = makeRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(mockFinalizeAndConfirmPurchase).toHaveBeenCalledWith('pay_ref_ok', 9900);
  });
});
