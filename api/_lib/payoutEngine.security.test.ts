import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Payout approval / Reconcile / webhook after 0202. No network: Supabase
// REST, Supabase Auth and Paystack are all served by the fetch mock below,
// and the privileged DB helper is mocked. Every assertion is about which
// money-moving calls happen, and with what transfer reference.

const adminRpc = vi.fn(async (..._args: unknown[]) => null as unknown);
const adminTableRpc = vi.fn(async (..._args: unknown[]) => [{ status: 'completed', amount_kobo: 100 }] as unknown[]);
vi.mock('./projectAdminDb', () => ({
  callProjectAdminRpc: (...a: unknown[]) => adminRpc(...a),
  callProjectAdminTableRpc: (...a: unknown[]) => adminTableRpc(...a),
}));
vi.mock('./mailer', () => ({ sendPayoutDecisionEmail: vi.fn(async () => true) }));

import { payoutTransferReference, lookupTransferByReference } from './paystackTransfers';

const REQUEST_ID = '11111111-2222-3333-4444-555555555555';
const REFERENCE = 'payout_11111111222233334444555555555555';
const SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let paystackTransfer: Handler;
let paystackVerify: Handler;
let markOk = true;
let claimRefusal: string | null = null;
const calls: { url: string; body?: any }[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, body });
  if (url === `${SUPABASE}/auth/v1/user`) return json(200, { id: 'admin-1', email: 'a@x' });
  if (url.endsWith('/rpc/admin_claim_payout_for_processing')) {
    if (claimRefusal) return json(400, { message: claimRefusal });
    return json(200, [{ request_id: REQUEST_ID, organizer_id: 'org', amount_kobo: 50000, recipient_code: 'RCP_1', status: 'processing', claimed: true }]);
  }
  if (url.endsWith('/rpc/admin_mark_payout_processing')) return markOk ? json(200, null) : json(400, { message: 'not processing' });
  if (url.endsWith('/rpc/admin_release_payout_claim')) return json(200, null);
  if (url.endsWith('/rpc/admin_list_processing_payouts')) return json(200, listRows);
  if (url === 'https://api.paystack.co/transfer') return paystackTransfer(url, init);
  if (url.startsWith('https://api.paystack.co/transfer/verify/')) return paystackVerify(url, init);
  if (url.startsWith('https://api.paystack.co/transfer/')) return json(200, { status: true, data: { status: 'success' } });
  throw new Error(`unexpected fetch ${url}`);
});

let listRows: any[] = [];
const savedEnv = { ...process.env };

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
const req = (body: unknown) => ({ method: 'POST', headers: { authorization: 'Bearer admin', origin: 'https://getvents.com' }, body, query: {} }) as any;

const transferPosts = () => calls.filter((c) => c.url === 'https://api.paystack.co/transfer');
const rpcCalls = (name: string) => calls.filter((c) => c.url.endsWith(`/rpc/${name}`));

beforeEach(() => {
  calls.length = 0;
  adminRpc.mockClear();
  adminTableRpc.mockClear();
  markOk = true;
  claimRefusal = null;
  listRows = [];
  paystackTransfer = () => json(200, { status: true, data: { transfer_code: 'TRF_1', status: 'pending' } });
  paystackVerify = () => json(404, { status: false, message: 'Transfer not found' });
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(process.env, { VERCEL_ENV: 'production', VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: 'anon', PAYSTACK_SECRET_KEY: 'sk_test_x' });
});
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...savedEnv }; });

async function approve() {
  const res = mockRes();
  await (await import('../wallet/admin-payout-action')).default(req({ action: 'approve', request_id: REQUEST_ID }), res);
  return res;
}

describe('fixed transfer reference', () => {
  it('matches public.payout_transfer_reference() in 0202', () => {
    expect(payoutTransferReference(REQUEST_ID)).toBe(REFERENCE);
  });

  it('is the same on every approval attempt, so Paystack refuses a duplicate', async () => {
    await approve();
    await approve();
    expect(transferPosts().map((c) => c.body.reference)).toEqual([REFERENCE, REFERENCE]);
  });
});

describe('approval', () => {
  it('accepted transfer: recorded as processing with its code, never as paid', async () => {
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'processing', reference: REFERENCE, transfer_code: 'TRF_1' });
    expect(rpcCalls('admin_mark_payout_processing')[0].body).toEqual({ p_request_id: REQUEST_ID, p_paystack_reference: REFERENCE, p_transfer_code: 'TRF_1' });
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
    expect(transferPosts()[0].body.amount).toBe(50000);
  });

  it('accepted but not recorded: reports it and does NOT release the request', async () => {
    markOk = false;
    const res = await approve();
    expect(res.statusCode).toBe(502);
    expect(res.body.status).toBe('processing');
    expect(res.body.error).toMatch(/Nothing has been marked paid/);
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
  });

  it('timeout, but Paystack has the transfer: records it, no second transfer, no release', async () => {
    paystackTransfer = () => { throw new Error('socket hang up'); };
    paystackVerify = () => json(200, { status: true, data: { transfer_code: 'TRF_late', status: 'pending' } });
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(transferPosts()).toHaveLength(1);
    expect(rpcCalls('admin_mark_payout_processing')[0].body.p_transfer_code).toBe('TRF_late');
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
  });

  it('rejected and Paystack confirms no transfer exists: released back to pending', async () => {
    paystackTransfer = () => json(400, { status: false, message: 'Insufficient balance' });
    const res = await approve();
    expect(res.statusCode).toBe(502);
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(1);
    expect(rpcCalls('admin_mark_payout_processing')).toHaveLength(0);
  });

  it('outcome unknown (Paystack unreachable twice): left processing, nothing released or marked', async () => {
    paystackTransfer = () => { throw new Error('timeout'); };
    paystackVerify = () => { throw new Error('timeout'); };
    const res = await approve();
    expect(res.statusCode).toBe(502);
    expect(res.body.status).toBe('processing');
    expect(res.body.error).toMatch(/Run Reconcile/);
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
    expect(rpcCalls('admin_mark_payout_processing')).toHaveLength(0);
  });

  it('a server error is not treated as "not found"', async () => {
    paystackTransfer = () => json(500, { status: false, message: 'Server error' });
    paystackVerify = () => json(500, { status: false, message: 'Server error' });
    await approve();
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
  });
});

describe('two-admin authorization (0203)', () => {
  it('a withdrawal the database refuses to claim (not authorized) never reaches Paystack', async () => {
    claimRefusal = "This withdrawal needs a second admin's authorization before it can be paid";
    const res = await approve();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/second admin's authorization/);
    expect(transferPosts()).toHaveLength(0);
    expect(rpcCalls('admin_mark_payout_processing')).toHaveLength(0);
  });

  it('a bank recipient changed after authorization is refused the same way', async () => {
    claimRefusal = 'The bank account changed after this withdrawal was authorized; authorize it again';
    const res = await approve();
    expect(res.statusCode).toBe(400);
    expect(transferPosts()).toHaveLength(0);
  });
});

describe('lookupTransferByReference', () => {
  it('only an explicit not-found counts as not found', async () => {
    paystackVerify = () => json(404, { status: false, message: 'Transfer not found' });
    expect((await lookupTransferByReference('sk', REFERENCE)).state).toBe('not_found');
    paystackVerify = () => json(502, {});
    expect((await lookupTransferByReference('sk', REFERENCE)).state).toBe('unknown');
    paystackVerify = () => new Response('<html>', { status: 200 });
    expect((await lookupTransferByReference('sk', REFERENCE)).state).toBe('unknown');
  });
});

describe('Reconcile', () => {
  async function reconcile() {
    const res = mockRes();
    await (await import('../wallet/reconcile-payouts')).default(req({}), res);
    return res;
  }
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  it('no code, not on Paystack, stuck for a while: released (the reference is kept, so no double pay)', async () => {
    listRows = [{ request_id: REQUEST_ID, transfer_code: null, paystack_reference: REFERENCE, updated_at: old }];
    const res = await reconcile();
    expect(res.body.results[0].outcome).toBe('released_to_pending');
    expect(adminTableRpc).not.toHaveBeenCalled();
  });

  it('no code, not on Paystack, just claimed: left alone (an approval may still be talking to Paystack)', async () => {
    listRows = [{ request_id: REQUEST_ID, transfer_code: null, paystack_reference: REFERENCE, updated_at: new Date().toISOString() }];
    const res = await reconcile();
    expect(res.body.results[0].outcome).toBe('not_on_paystack_yet');
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
  });

  it('no code, found on Paystack as reversed: reversal, by reference', async () => {
    listRows = [{ request_id: REQUEST_ID, transfer_code: null, paystack_reference: REFERENCE, updated_at: old }];
    paystackVerify = () => json(200, { status: true, data: { transfer_code: 'TRF_9', status: 'reversed' } });
    await reconcile();
    expect(adminTableRpc).toHaveBeenCalledWith('reverse_organizer_payout', [REFERENCE, 'Reconciled from Paystack status: reversed']);
  });

  it('unknown Paystack answer: nothing changes', async () => {
    listRows = [{ request_id: REQUEST_ID, transfer_code: null, paystack_reference: REFERENCE, updated_at: old }];
    paystackVerify = () => json(503, {});
    const res = await reconcile();
    expect(res.body.results[0].outcome).toBe('paystack_lookup_failed');
    expect(adminTableRpc).not.toHaveBeenCalled();
    expect(rpcCalls('admin_release_payout_claim')).toHaveLength(0);
  });
});

describe('webhook source', () => {
  it('routes transfer.reversed to the reversal, success to completion, failure to failure', async () => {
    const src = readFileSync(join(__dirname, '..', 'webhook', 'paystack.ts'), 'utf8');
    expect(src).toMatch(/event\.event === 'transfer\.reversed' \? 'reverse_organizer_payout' : 'fail_organizer_payout'/);
    expect(src).toMatch(/await callProjectAdminTableRpc<any>\('complete_organizer_payout', \[lookupKey\]\)/);
  });

  it('a Paystack dispute freezes the disputed sale\'s held earnings (0203)', () => {
    const src = readFileSync(join(__dirname, '..', 'webhook', 'paystack.ts'), 'utf8');
    expect(src).toMatch(/event\?\.event === 'charge\.dispute\.create' \|\| event\?\.event === 'charge\.dispute\.remind'/);
    expect(src).toMatch(/callProjectAdminRpc<string>\('place_payment_dispute_hold', \[disputedReference, disputeId\]\)/);
    // A failure asks Paystack to retry rather than silently dropping the dispute.
    const block = src.slice(src.indexOf("'charge.dispute.create'"), src.indexOf('Organizer payout transfer status'));
    expect(block).toMatch(/hadTransientFailure = true;/);
  });

  it('approval never builds a time-based reference any more', async () => {
    const src = readFileSync(join(__dirname, '..', 'wallet', 'admin-payout-action.ts'), 'utf8');
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).toMatch(/const reference = payoutTransferReference\(request_id\);/);
  });
});
