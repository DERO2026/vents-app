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
    const none = { refundClaimed: false, refundQueued: false, excessQueued: false };
    expect(parseTransferFeeStatus('expired:refund_claimed')).toEqual({ ...none, feeStatus: 'expired', refundClaimed: true });
    expect(parseTransferFeeStatus('transfer_not_pending:cancelled:refund_queued')).toEqual({ ...none, feeStatus: 'transfer_not_pending:cancelled', refundQueued: true });
    expect(parseTransferFeeStatus('amount_mismatch:75000:50000:refund_queued')).toEqual({ ...none, feeStatus: 'amount_mismatch:75000:50000', refundQueued: true });
    expect(parseTransferFeeStatus('confirmed:excess_refund_queued')).toEqual({ ...none, feeStatus: 'confirmed', excessQueued: true });
    expect(parseTransferFeeStatus('confirmed')).toEqual({ ...none, feeStatus: 'confirmed' });
    expect(parseTransferFeeStatus(null)).toEqual({ ...none, feeStatus: null });
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
      expect(body.error).toMatch(/A refund has been recorded and is waiting for approval by VENTS/);
      expect(body.refundState).toBe('pending_review');
      expect(body.error).toContain('txf_q1');
      expect(refundCalls()).toHaveLength(0);
    });
  }

  it('buyer\'s verify, duplicate payment recorded (0239): not a success; the extra payment is waiting for approval', async () => {
    confirmAnswers('duplicate_payment:refund_queued');
    const res = makeRes();
    await handler(verifyReq('txf_dup'), res);
    const body = res.json.mock.calls.at(-1)[0];
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/already been paid for.*A refund has been recorded and is waiting for approval/);
    expect(refundCalls()).toHaveLength(0);
  });

  it('a database answering with 0064\'s \':refund_claimed\': no automatic Paystack refund (two admins required); told it is recorded', async () => {
    confirmAnswers('expired:refund_claimed');
    const res = makeRes();
    await handler(webhookReq({ event: 'charge.success', data: { reference: 'txf_old', amount: 75000 } }), res);
    expect(refundCalls()).toHaveLength(0);
    expect(m.rpc.mock.calls.map(([fn]) => fn)).not.toContain('attach_transfer_fee_refund_id');
    const vres = makeRes();
    await handler(verifyReq('txf_old'), vres);
    expect(refundCalls()).toHaveLength(0);
    expect(vres.json.mock.calls.at(-1)[0].refundState).toBe('pending_review');
  });
});

// P0 2026-11-27: production runs 0043 + an amount-rule edit, with no 0064,
// 0233 or 0238, so confirm_transfer_fee_payment answers WITHOUT a suffix and
// records nothing when a paid fee cannot complete the transfer. The verify
// path used to tell these payers "a refund has been started automatically and
// should appear on your statement shortly". It must say no refund has started.
describe('production shape (no refund recorded): never claims a refund has started', () => {
  const cases: [string, string, RegExp][] = [
    ['expired transfer', 'expired', /expired before your payment was confirmed/],
    ['cancelled transfer', 'transfer_not_pending:cancelled', /was cancelled before your payment was confirmed/],
    ['declined transfer', 'transfer_not_pending:declined', /was cancelled before your payment was confirmed/],
    ['already accepted (not pending)', 'transfer_not_pending:accepted', /no longer pending/],
    ['ineligible ticket', 'ticket_ineligible', /can no longer be transferred/],
    ['missing payment record (unknown reference)', 'not_found', /could not match it to a transfer/],
    ['underpayment', 'amount_mismatch:75000:50000', /less than the transfer fee/],
    ['duplicate payment, unrecorded', 'duplicate_payment', /already been paid for/],
  ];
  for (const [label, answer, problem] of cases) {
    it(`${label}: error, reference kept, "no refund has been started", no Paystack refund`, async () => {
      confirmAnswers(answer);
      const res = makeRes();
      await handler(verifyReq('txf_prod1'), res);
      const body = res.json.mock.calls.at(-1)[0];
      expect(body.status).toBe('error');
      expect(body.reference).toBe('txf_prod1');
      expect(body.refundState).toBe('not_recorded');
      expect(body.error).toMatch(problem);
      expect(body.error).toContain('Your payment reference is txf_prod1');
      expect(body.error).toContain('No refund has been started yet');
      expect(body.error).not.toMatch(/started automatically|statement shortly|refund has been requested|will be refunded/i);
      expect(refundCalls()).toHaveLength(0);
    });

    it(`${label}: signed webhook answers 200 (terminal), logs it as unrecorded, no Paystack refund`, async () => {
      confirmAnswers(answer);
      const res = makeRes();
      await handler(webhookReq({ event: 'charge.success', data: { reference: 'txf_prod1', amount: 50000 } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(refundCalls()).toHaveLength(0);
      expect((console.error as any).mock.calls.some((c: any[]) => /NO REFUND RECORDED/.test(String(c[0])))).toBe(true);
    });
  }

  it('an unrecognised answer is never reported as a success', async () => {
    confirmAnswers('something_new');
    const res = makeRes();
    await handler(verifyReq('txf_odd'), res);
    const body = res.json.mock.calls.at(-1)[0];
    expect(body.status).toBe('error');
    expect(body.refundState).toBe('not_recorded');
    expect(body.error).toContain('txf_odd');
  });

  it('confirmed: success, unchanged', async () => {
    confirmAnswers('confirmed');
    const res = makeRes();
    await handler(verifyReq('txf_ok'), res);
    expect(res.json.mock.calls.at(-1)[0]).toEqual({ status: 'success' });
  });

  it('0239 overpayment: success, plus a notice that the excess is recorded and awaiting approval', async () => {
    confirmAnswers('confirmed:excess_refund_queued');
    const res = makeRes();
    await handler(verifyReq('txf_over'), res);
    const body = res.json.mock.calls.at(-1)[0];
    expect(body.status).toBe('success');
    expect(body.refundState).toBe('pending_review');
    expect(body.notice).toMatch(/extra amount has been recorded for a refund and is waiting for approval/);
    expect(body.notice).toContain('txf_over');
    expect(refundCalls()).toHaveLength(0);
  });
});

// Pre-existing production bug found 2026-11-27: 0064 is not applied, so
// finalize_/fail_transfer_fee_refund don't exist (42883). That error made the
// webhook answer 500 for every refund event that wasn't a ticket refund, so a
// service-booking refund could never be finalized.
describe('refund events when 0064 is absent (production)', () => {
  const missing = Object.assign(new Error('function public.finalize_transfer_fee_refund(text) does not exist'), { code: '42883' });
  function chain(kind: 'processed' | 'failed') {
    m.tableRpc.mockImplementation(async (fn: string) => {
      if (fn === 'finalize_ticket_refund' || fn === 'fail_ticket_refund') return [{ status: 'not_found' }];
      if (fn === 'finalize_transfer_fee_refund') throw missing;
      if (fn === 'finalize_service_booking_refund' || fn === 'fail_service_booking_refund') return [{ status: kind === 'processed' ? 'refunded' : 'failed' }];
      return [];
    });
    m.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'fail_transfer_fee_refund') throw Object.assign(new Error('missing'), { code: '42883' });
      return null;
    });
  }
  for (const kind of ['processed', 'failed'] as const) {
    it(`refund.${kind} for a service booking reaches the booking link and answers 200`, async () => {
      chain(kind);
      const res = makeRes();
      await handler(webhookReq({ event: `refund.${kind}`, data: { id: 9001, message: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(m.tableRpc.mock.calls.map(([fn]) => fn)).toContain(kind === 'processed' ? 'finalize_service_booking_refund' : 'fail_service_booking_refund');
    });
  }
  it('any other database error still fails the event (500) so Paystack retries', async () => {
    m.tableRpc.mockImplementation(async (fn: string) => {
      if (fn === 'finalize_ticket_refund') return [{ status: 'not_found' }];
      if (fn === 'finalize_transfer_fee_refund') throw Object.assign(new Error('connection reset'), { code: '08006' });
      return [];
    });
    const res = makeRes();
    await handler(webhookReq({ event: 'refund.processed', data: { id: 9002 } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// 0239 (not yet applied) answers: every literal answer the migration can
// return must reach the payer as "recorded, waiting for approval" (or, for
// an overpayment, as a success with that notice) -- never as "not recorded",
// and never as a plain success that hides money owed back.
describe('0239 answers, end to end through the verify path', () => {
  const failed = ['not_found:refund_queued', 'amount_mismatch:50000:1000:refund_queued', 'amount_mismatch:50000:null:refund_queued',
    'duplicate_payment:refund_queued', 'expired:refund_queued', 'transfer_not_pending:declined:refund_queued',
    'transfer_not_pending:cancelled:refund_queued', 'ticket_ineligible:refund_queued'];
  for (const answer of failed) {
    it(`${answer}: error, pending_review, reference kept`, async () => {
      confirmAnswers(answer);
      const res = makeRes();
      await handler(verifyReq('txf_0239'), res);
      const body = res.json.mock.calls.at(-1)[0];
      expect(body.status).toBe('error');
      expect(body.refundState).toBe('pending_review');
      expect(body.error).toContain('txf_0239');
      expect(refundCalls()).toHaveLength(0);
    });
  }
  for (const answer of ['confirmed:excess_refund_queued', 'already_paid:excess_refund_queued']) {
    it(`${answer}: success with the excess-refund notice`, async () => {
      confirmAnswers(answer);
      const res = makeRes();
      await handler(verifyReq('txf_0239'), res);
      const body = res.json.mock.calls.at(-1)[0];
      expect(body.status).toBe('success');
      expect(body.notice).toMatch(/extra amount has been recorded for a refund/);
    });
  }
  it('every answer literal in the migration is one of the above', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0239_transfer_fee_payment_safety_live.sql'), 'utf8');
    const confirm = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.confirm_transfer_fee_payment'));
    const literals = new Set([...confirm.matchAll(/'([a-z_]+(?::[a-z_]+)*:(?:refund_queued|excess_refund_queued))'/g)].map((m) => m[1]));
    for (const l of literals) {
      const covered = [...failed, 'confirmed:excess_refund_queued', 'already_paid:excess_refund_queued'].some((a) => a === l || a.endsWith(l));
      expect(covered, `uncovered 0239 answer ${l}`).toBe(true);
    }
    expect(confirm).toMatch(/':refund_queued'/);   // composed answers (expired / not pending / ineligible / amount) end with it
  });
});
