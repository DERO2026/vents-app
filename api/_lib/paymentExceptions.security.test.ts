import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// H1 / OEL-02 (docs/repair-tracker.md, migration 0226): a captured ticket
// payment that cannot become a ticket must be RECORDED (idempotently, per
// reference) on both entry points, the buyer must be told the truth, and a
// later retry that does issue the ticket must close the record. Nothing
// here may refund or move money.

const m = vi.hoisted(() => ({
  finalize: vi.fn(),
  booking: vi.fn(),
  rpc: vi.fn(),
  tableRpc: vi.fn(),
  session: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock('./mailer.js', () => ({ sendPayoutDecisionEmail: vi.fn(), sendTicketRefundEmail: vi.fn() }));
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminRpc: m.rpc, callProjectAdminTableRpc: m.tableRpc }));
vi.mock('./finalizePaystackPayment.js', () => ({ finalizeAndConfirmPurchase: m.finalize, finalizeAndConfirmServiceBooking: m.booking }));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: m.session, enforceRateLimit: m.rateLimit }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./pushDelivery.js', () => ({ deliverPendingPushesForUser: vi.fn() }));

import handler from '../webhook/paystack';
import { buyerMessageForException, isTicketPurchaseReference } from './paymentExceptions';

const SECRET = 'sk_test_webhook_secret';
const sign = (raw: string) => crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
function webhookReq(body: any) {
  const raw = JSON.stringify(body);
  const req: any = Readable.from([Buffer.from(raw)]);
  req.method = 'POST'; req.headers = { 'x-paystack-signature': sign(raw) }; req.query = {};
  return req;
}
function verifyReq(reference: string) {
  const req: any = Readable.from([Buffer.from(JSON.stringify({ reference }))]);
  req.method = 'POST'; req.headers = { authorization: 'Bearer tok' }; req.query = { action: 'verify' };
  return req;
}
function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res); res.json = vi.fn(() => res); res.end = vi.fn(() => res); res.setHeader = vi.fn(() => res);
  return res;
}
const rpcCalls = (name: string) => m.rpc.mock.calls.filter(([fn]) => fn === name);
const charge = (reference: string, amount = 1522500) => ({ event: 'charge.success', data: { reference, amount } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  m.session.mockResolvedValue({ userId: 'buyer-1', email: 'buyer@example.com' });
  m.rateLimit.mockResolvedValue(true);
  m.rpc.mockResolvedValue(null);
  m.tableRpc.mockResolvedValue([{ payment_ref: 'pay-ref-1', owner_id: 'buyer-1', payer_id: null }]);
  // Paystack's own verify: captured.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: true, data: { status: 'success', amount: 1522500 } }) })));
});
afterEach(() => vi.unstubAllGlobals());

describe('signed webhook (charge.success)', () => {
  it('sold out after paying: records the exception with the reason, answers 200', async () => {
    m.finalize.mockResolvedValue({ status: 'not_found', finalizeError: 'Only 0 VIP ticket(s) remaining' });
    const res = makeRes();
    await handler(webhookReq(charge('PSK-abc')), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(rpcCalls('record_payment_exception')).toEqual([[
      'record_payment_exception', ['PSK-abc', 'pay-ref-1', 'not_found', 'Only 0 VIP ticket(s) remaining', 1522500, null, 'webhook'],
    ]]);
    expect(rpcCalls('mark_payment_exception_ticketed')).toHaveLength(0);
  });

  it('amount mismatch: records it with the expected amount', async () => {
    m.finalize.mockResolvedValue({ status: 'amount_mismatch', expectedKobo: 1522500, gotKobo: 100 });
    await handler(webhookReq(charge('PSK-mm', 100)), makeRes());
    expect(rpcCalls('record_payment_exception')[0][1]).toEqual(['PSK-mm', 'pay-ref-1', 'amount_mismatch', null, 100, 1522500, 'webhook']);
  });

  it('if recording fails, answers 500 so Paystack retries (the record is idempotent)', async () => {
    m.finalize.mockResolvedValue({ status: 'not_found', finalizeError: 'This event has already ended' });
    m.rpc.mockImplementation(async (fn: string) => { if (fn === 'record_payment_exception') throw new Error('connection reset'); return null; });
    const res = makeRes();
    await handler(webhookReq(charge('PSK-retry')), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('a non-ticket charge that falls through (event promotion, vents_ reference, no pending purchase) is NOT recorded', async () => {
    m.tableRpc.mockResolvedValue([]);
    m.finalize.mockResolvedValue({ status: 'not_found' });
    const res = makeRes();
    await handler(webhookReq(charge('vents_1795_abc')), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(rpcCalls('record_payment_exception')).toHaveLength(0);
  });

  it('a retry that issues the ticket closes any open exception', async () => {
    m.finalize.mockResolvedValue({ status: 'confirmed', ticketIds: ['t1'] });
    await handler(webhookReq(charge('PSK-ok')), makeRes());
    expect(rpcCalls('mark_payment_exception_ticketed')).toEqual([['mark_payment_exception_ticketed', ['PSK-ok']]]);
    expect(rpcCalls('record_payment_exception')).toHaveLength(0);
  });

  it('already_paid also closes it (verify won the race)', async () => {
    m.finalize.mockResolvedValue({ status: 'already_paid', ticketIds: ['t1'] });
    await handler(webhookReq(charge('PSK-dup')), makeRes());
    expect(rpcCalls('mark_payment_exception_ticketed')).toHaveLength(1);
  });
});

describe('client verify (?action=verify)', () => {
  it('sold out after paying: records it and tells the buyer the payment was received, with the reason and reference', async () => {
    m.finalize.mockResolvedValue({ status: 'not_found', finalizeError: 'Only 0 VIP ticket(s) remaining' });
    const res = makeRes();
    await handler(verifyReq('PSK-v1'), res);
    expect(rpcCalls('record_payment_exception')[0][1]).toEqual(['PSK-v1', 'pay-ref-1', 'not_found', 'Only 0 VIP ticket(s) remaining', 1522500, null, 'verify']);
    const body = res.json.mock.calls.at(-1)[0];
    expect(body.status).toBe('error');
    expect(body.error).toBe('We received your payment, but your ticket could not be issued (Only 0 VIP ticket(s) remaining). It has been recorded under reference PSK-v1 and our team will contact you to resolve it.');
    expect(body.error).not.toMatch(/No matching order|not been charged/);
  });

  it('a recording failure does not change the buyer\'s answer', async () => {
    m.finalize.mockResolvedValue({ status: 'not_found' });
    m.rpc.mockImplementation(async (fn: string) => { if (fn === 'record_payment_exception') throw new Error('down'); return null; });
    const res = makeRes();
    await handler(verifyReq('PSK-v2'), res);
    expect(res.json.mock.calls.at(-1)[0].error).toMatch(/^We received your payment, but your ticket could not be issued\. It has been recorded under reference PSK-v2/);
  });

  it('success closes any open exception and returns the tickets as before', async () => {
    m.finalize.mockResolvedValue({ status: 'confirmed', ticketIds: ['t9'] });
    const res = makeRes();
    await handler(verifyReq('PSK-v3'), res);
    expect(rpcCalls('mark_payment_exception_ticketed')).toEqual([['mark_payment_exception_ticketed', ['PSK-v3']]]);
    expect(res.json.mock.calls.at(-1)[0]).toEqual({ status: 'success', ticketIds: ['t9'] });
  });

  it('never calls a refund, wallet or payout function', async () => {
    m.finalize.mockResolvedValue({ status: 'not_found', finalizeError: 'This event has already ended' });
    await handler(verifyReq('PSK-v4'), makeRes());
    await handler(webhookReq(charge('PSK-v4')), makeRes());
    const names = m.rpc.mock.calls.map(([fn]) => fn);
    expect(names.every((n) => ['record_payment_exception', 'mark_payment_exception_ticketed'].includes(n))).toBe(true);
  });
});

describe('helpers', () => {
  it('only provable ticket references qualify', () => {
    expect(isTicketPurchaseReference('PSK-x', false)).toBe(true);
    expect(isTicketPurchaseReference('legacy-payment-ref', true)).toBe(true);
    expect(isTicketPurchaseReference('vents_123_abc', false)).toBe(false);
  });
  it('buyer message for an amount mismatch', () => {
    expect(buyerMessageForException({ status: 'amount_mismatch', expectedKobo: 2, gotKobo: 1 }, 'PSK-z'))
      .toBe('We received your payment, but your ticket could not be issued (the amount paid did not match the order). It has been recorded under reference PSK-z and our team will contact you to resolve it.');
  });
});
