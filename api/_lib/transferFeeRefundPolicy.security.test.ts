import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'crypto';

// Owner decision 2026-11-27 (migration 0238): a paid transfer fee whose
// transfer can't complete is NO LONGER refunded automatically. The database
// answers with ':refund_queued' and records a payment exception for the
// two-admin flow; neither entry point may call Paystack's refund API for it.
// The old ':refund_claimed' answer (a database without 0238) keeps working
// as before. A duplicate payment (0233) must never be reported to the buyer
// as a success, and a queued refund must never be reported as a completed
// transfer.

const m = vi.hoisted(() => ({
  finalize: vi.fn(), booking: vi.fn(), rpc: vi.fn(), tableRpc: vi.fn(), session: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock('./mailer.js', () => ({ sendPayoutDecisionEmail: vi.fn(), sendTicketRefundEmail: vi.fn() }));
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminRpc: m.rpc, callProjectAdminTableRpc: m.tableRpc }));
vi.mock('./finalizePaystackPayment.js', () => ({ finalizeAndConfirmPurchase: m.finalize, finalizeAndConfirmServiceBooking: m.booking }));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: m.session, enforceRateLimit: m.rateLimit }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./pushDelivery.js', () => ({ deliverPendingPushesForUser: vi.fn() }));

import handler, { parseTransferFeeStatus } from '../webhook/paystack';

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
let fetchMock: ReturnType<typeof vi.fn>;
const refundCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('api.paystack.co/refund'));
function confirmAnswers(answer: string) {
  m.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'get_transfer_fee_payment_owner') return 'recipient-1';
    if (fn === 'confirm_transfer_fee_payment') return answer;
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  m.session.mockResolvedValue({ userId: 'recipient-1', email: 'r@example.com' });
  m.rateLimit.mockResolvedValue(true);
  fetchMock = vi.fn(async (url: string) => String(url).includes('/refund')
    ? ({ ok: true, status: 200, json: async () => ({ status: true, data: { id: 555 } }) })
    : ({ ok: true, status: 200, json: async () => ({ status: true, data: { status: 'success', amount: 75000 } }) }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('parseTransferFeeStatus', () => {
  it('splits both suffixes and leaves plain answers alone', () => {
    expect(parseTransferFeeStatus('expired:refund_claimed')).toEqual({ feeStatus: 'expired', refundClaimed: true, refundQueued: false });
    expect(parseTransferFeeStatus('transfer_not_pending:cancelled:refund_queued')).toEqual({ feeStatus: 'transfer_not_pending:cancelled', refundClaimed: false, refundQueued: true });
    expect(parseTransferFeeStatus('confirmed')).toEqual({ feeStatus: 'confirmed', refundClaimed: false, refundQueued: false });
    expect(parseTransferFeeStatus(null)).toEqual({ feeStatus: null, refundClaimed: false, refundQueued: false });
  });
});

describe('0238: queued transfer-fee refunds never reach Paystack automatically', () => {
  for (const answer of ['transfer_not_pending:cancelled:refund_queued', 'expired:refund_queued', 'ticket_ineligible:refund_queued']) {
    it(`signed webhook, ${answer}: 200, no Paystack refund, no refund bookkeeping`, async () => {
      confirmAnswers(answer);
      const res = makeRes();
      await handler(webhookReq({ event: 'charge.success', data: { reference: 'txf_q1', amount: 75000 } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(refundCalls()).toHaveLength(0);
      expect(m.rpc.mock.calls.map(([fn]) => fn)).not.toContain('attach_transfer_fee_refund_id');
    });

    it(`buyer's verify, ${answer}: told it failed and that a refund was requested for review, never "success"`, async () => {
      confirmAnswers(answer);
      const res = makeRes();
      await handler(verifyReq('txf_q1'), res);
      const body = res.json.mock.calls.at(-1)[0];
      expect(body.status).toBe('error');
      expect(body.error).toMatch(/a refund has been requested and is paid back after review by VENTS/);
      expect(refundCalls()).toHaveLength(0);
    });
  }

  it('buyer\'s verify, duplicate payment: not a success; told the extra payment is recorded for a refund', async () => {
    confirmAnswers('duplicate_payment');
    const res = makeRes();
    await handler(verifyReq('txf_dup'), res);
    const body = res.json.mock.calls.at(-1)[0];
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/already paid.*extra payment was recorded and will be refunded after review/);
    expect(refundCalls()).toHaveLength(0);
  });

  it('a database without 0238 (\':refund_claimed\') keeps the previous automatic refund, exactly once', async () => {
    confirmAnswers('expired:refund_claimed');
    const res = makeRes();
    await handler(webhookReq({ event: 'charge.success', data: { reference: 'txf_old', amount: 75000 } }), res);
    expect(refundCalls()).toHaveLength(1);
    expect(m.rpc).toHaveBeenCalledWith('attach_transfer_fee_refund_id', ['txf_old', '555']);
  });
});
