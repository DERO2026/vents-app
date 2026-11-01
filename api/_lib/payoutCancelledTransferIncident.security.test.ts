import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'crypto';

// Regression tests for the 2026-07 payout incident: four ₦100 LIVE
// transfers (requests 3aa0f8ff, f9fda363, 6ad1272d, 56b084bb) were paid by
// Paystack but are 'cancelled' in VENTS, with no ledger row, because a raw
// UPDATE ("platform launch sweep") cancelled them while they were in flight.
// Real-database behaviour is verified by
// scripts/local-pg-test/run-payout-cancelled-transfer-verification.sh (47
// checks); these tests cover the webhook and the migration text.

const { mockTableRpc, mockRpc, mockEmail } = vi.hoisted(() => ({
  mockTableRpc: vi.fn(),
  mockRpc: vi.fn(),
  mockEmail: vi.fn(async () => true),
}));
vi.mock('./mailer.js', () => ({ sendPayoutDecisionEmail: mockEmail, sendTicketRefundEmail: vi.fn() }));
vi.mock('./projectAdminDb.js', () => ({ callProjectAdminRpc: mockRpc, callProjectAdminTableRpc: mockTableRpc }));
vi.mock('./finalizePaystackPayment.js', () => ({ finalizeAndConfirmPurchase: vi.fn(), finalizeAndConfirmServiceBooking: vi.fn() }));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: vi.fn(), enforceRateLimit: vi.fn() }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./pushDelivery.js', () => ({ deliverPendingPushesForUser: vi.fn() }));

import handler from '../webhook/paystack';

const SECRET = 'sk_test_webhook_secret';
function deliver(event: unknown) {
  const buf = Buffer.from(JSON.stringify(event));
  const req: any = Readable.from([buf]);
  req.method = 'POST';
  req.headers = { 'x-paystack-signature': crypto.createHmac('sha512', SECRET).update(buf).digest('hex') };
  req.query = {};
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return { req, res };
}

// One of the four incident transfers, as Paystack sends it.
const INCIDENT = {
  event: 'transfer.success',
  data: { transfer_code: 'TRF_5x4kfsos12pysbiz', reference: 'payout_3aa0f8ff-d652-48cb-a06f-82a99d434dbe_1783681361539', amount: 10000, currency: 'NGN', status: 'success' },
};

beforeEach(() => {
  vi.resetAllMocks();  // also drops queued mockResolvedValueOnce values
  mockEmail.mockResolvedValue(true);
  process.env.PAYSTACK_SECRET_KEY = SECRET;
});

describe('webhook: a paid transfer for a cancelled request', () => {
  it('a replayed success that the database flags needs_review: 200 (no retry storm), no email, loud log', async () => {
    mockTableRpc.mockResolvedValue([{ status: 'needs_review', amount_kobo: 10000 }]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = deliver(INCIDENT);
    await handler(req, res);
    expect(mockTableRpc).toHaveBeenCalledWith('complete_organizer_payout', ['TRF_5x4kfsos12pysbiz']);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockEmail).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('PAYOUT NEEDS REVIEW'))).toBe(true);
    errSpy.mockRestore();
  });

  it('the same event delivered four times calls the idempotent completion each time and never emails', async () => {
    mockTableRpc.mockResolvedValue([{ status: 'needs_review', amount_kobo: 10000 }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 4; i++) {
      const { req, res } = deliver(INCIDENT);
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    }
    expect(mockEmail).not.toHaveBeenCalled();
  });
});

describe('webhook: success for a request whose "mark sent" step failed', () => {
  it('not found by transfer code -> retried by the fixed reference, and completed', async () => {
    mockTableRpc
      .mockResolvedValueOnce([{ status: 'not_found' }])
      .mockResolvedValueOnce([{ status: 'completed', organizer_email: 'o@x', organizer_name: 'O', amount_kobo: 50000 }]);
    const { req, res } = deliver({ event: 'transfer.success', data: { transfer_code: 'TRF_new', reference: 'payout_abc', amount: 50000 } });
    await handler(req, res);
    expect(mockTableRpc.mock.calls.map((c) => c[1][0])).toEqual(['TRF_new', 'payout_abc']);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });

  it('a failure is retried by reference the same way', async () => {
    mockTableRpc.mockResolvedValueOnce([{ status: 'not_found' }]).mockResolvedValueOnce([{ status: 'failed', amount_kobo: 50000 }]);
    const { req, res } = deliver({ event: 'transfer.failed', data: { transfer_code: 'TRF_new', reference: 'payout_abc', reason: 'bank down' } });
    await handler(req, res);
    expect(mockTableRpc.mock.calls[1]).toEqual(['fail_organizer_payout', ['payout_abc', 'bank down']]);
  });

  it('found by transfer code: no second lookup', async () => {
    mockTableRpc.mockResolvedValue([{ status: 'already_completed' }]);
    const { req, res } = deliver({ event: 'transfer.success', data: { transfer_code: 'TRF_1', reference: 'payout_1' } });
    await handler(req, res);
    expect(mockTableRpc).toHaveBeenCalledTimes(1);
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it('a database error still yields 500 so Paystack retries', async () => {
    mockTableRpc.mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { req, res } = deliver(INCIDENT);
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('migration 0205 (text)', () => {
  const sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0205_payout_cancelled_transfer_safety.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');

  it('refuses to run unless 0203 is applied with its exact complete_organizer_payout body', () => {
    expect(code).toMatch(/md5\(v_src\) <> 'dbcccdb9de313981b6ab81e899e3cd63'/);
    expect(code).toMatch(/apply 0201, 0202 and 0203 first/);
  });

  it('takes money back from a cancelled request only with evidence the cancel returned it', () => {
    expect(code).toMatch(/t\.type = 'cancelled_payout_refund'/);
    expect(code).toMatch(/l\.action = 'cancel_processing_payout'/);
    expect(code).toMatch(/IF v_status = ''cancelled'' AND NOT public\.payout_cancel_returned_funds\(v_id\) THEN/);
    expect(code).toMatch(/RETURN QUERY SELECT ''needs_review''::text/);
  });

  it('the new branch runs before the wallet is locked or changed', () => {
    expect(code).toMatch(/v_anchor text := E'  SELECT w\.balance_kobo INTO v_balance FROM public\.organizer_wallets w\\n'/);
    expect(code).toMatch(/replace\(v_def, v_anchor, v_new \|\| v_anchor\)/);
  });

  it('a trigger stops raw status edits like the July sweep', () => {
    expect(code).toMatch(/BEFORE UPDATE ON public\.organizer_withdrawal_requests/);
    expect(code).toMatch(/IF NEW\.status IN \('cancelled', 'rejected'\) THEN\s*\n\s*IF v_has_transfer OR \(OLD\.status = 'processing' AND OLD\.paystack_reference IS NOT NULL\)/);
    expect(code).toMatch(/BEFORE DELETE ON public\.organizer_withdrawal_requests/);
  });

  it('changes no balance, ledger row or request when applied', () => {
    expect(code).not.toMatch(/^\s*(UPDATE|INSERT INTO|DELETE FROM)\s+public\.(organizer_wallets|organizer_transactions|organizer_withdrawal_requests)\b/m);
  });

  it('the integrity report is admin-only and read-only', () => {
    expect(code).toMatch(/FUNCTION public\.admin_payout_integrity_report\(\)[\s\S]*?STABLE[\s\S]*?public\.is_admin\(\)/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.admin_payout_integrity_report\(\) FROM PUBLIC, anon;/);
  });
});

describe('the incident source stays documented', () => {
  it('the July sweep is the statement the local reproduction runs verbatim', () => {
    const sweep = readFileSync(join(__dirname, '..', '..', 'migrations', '20260713100000_admin-stats-and-payout-cleanup.sql'), 'utf8');
    expect(sweep).toMatch(/SET status = 'cancelled',\s*\n\s*admin_note = 'Test payout request cleared during platform launch sweep'/);
    expect(sweep).toMatch(/AND w\.status IN \('pending', 'processing'\);/);
    const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'local-pg-test', 'run-payout-cancelled-transfer-verification.sh'), 'utf8');
    expect(script).toMatch(/SWEEP=\$\(awk '\/\^UPDATE public\.organizer_withdrawal_requests w\/,\/;\$\/' "\$SWEEP_SQL"\)/);
  });
});
