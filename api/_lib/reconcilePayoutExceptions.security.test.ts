import { describe, it, expect, vi, beforeEach } from 'vitest';

// reconcile-payouts.ts mode 'exceptions' (2026-07 incident): four NGN 100
// transfers were paid by Paystack (LIVE, success) while VENTS shows the
// withdrawal requests as cancelled with no ledger row. The exceptions mode
// lists such requests and asks Paystack about each one -- report-only: it
// must never call a money function or change a record.

const { mockCallProjectAdminTableRpc, mockSendPayoutDecisionEmail } = vi.hoisted(() => ({
  mockCallProjectAdminTableRpc: vi.fn(),
  mockSendPayoutDecisionEmail: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({ callProjectAdminTableRpc: mockCallProjectAdminTableRpc }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./mailer.js', () => ({ sendPayoutDecisionEmail: mockSendPayoutDecisionEmail }));

import handler from '../wallet/reconcile-payouts';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}
const req = (body: any = { mode: 'exceptions' }) => ({ method: 'POST', headers: { authorization: 'Bearer tok' }, body }) as any;

// The four production records (ids from the owner's Paystack check).
const INCIDENT = [
  ['3aa0f8ff-d652-48cb-a06f-82a99d434dbe', '1783681361539'],
  ['f9fda363-8e24-45af-8d2a-74dd7edb61aa', '1783681476919'],
  ['6ad1272d-14b8-41d9-8267-7ce8c0b3b4e8', '1783681779407'],
  ['56b084bb-21df-4f23-9c90-02a5087f9642', '1783683296950'],
].map(([id, ts], i) => ({
  request_id: id, organizer_id: '91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', amount_kobo: 10000, request_status: 'cancelled',
  transfer_code: `TRF_incident_${i}`, paystack_reference: `payout_${id}_${ts}`, exception_kind: 'transfer_code_on_cancelled_request',
}));

function stubFetch(rows: any[], paystack: (code: string) => { ok: boolean; body: any }, listStatus = 200) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/rpc/admin_list_payout_exceptions')) {
      return { ok: listStatus === 200, status: listStatus, json: async () => (listStatus === 200 ? rows : { message: 'Admin access required' }) } as any;
    }
    if (url.includes('api.paystack.co/transfer/')) {
      const code = decodeURIComponent(url.split('/transfer/')[1]);
      const r = paystack(code);
      return { ok: r.ok, json: async () => r.body } as any;
    }
    return { ok: true, json: async () => [] } as any;
  });
  return { fn, calls };
}

beforeEach(() => {
  mockCallProjectAdminTableRpc.mockReset();
  mockSendPayoutDecisionEmail.mockReset();
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

describe('reconcile-payouts mode=exceptions (report-only)', () => {
  it('reports the four paid-but-cancelled incident transfers as paid_not_recorded', async () => {
    const { fn } = stubFetch(INCIDENT, (code) => ({ ok: true, body: { data: { status: 'success', reference: `ref-for-${code}` } } }));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const out = res.json.mock.calls[0][0];
    expect(out.mode).toBe('exceptions');
    expect(out.changed).toBe(0);
    expect(out.report).toHaveLength(4);
    expect(out.report.every((r: any) => r.finding === 'paid_not_recorded' && r.request_status === 'cancelled')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('never calls a money function or a mutating RPC, whatever Paystack says', async () => {
    const { fn, calls } = stubFetch(INCIDENT, () => ({ ok: true, body: { data: { status: 'success' } } }));
    vi.stubGlobal('fetch', fn);
    await handler(req(), makeRes());
    expect(mockCallProjectAdminTableRpc).not.toHaveBeenCalled();
    expect(mockSendPayoutDecisionEmail).not.toHaveBeenCalled();
    const rpcCalls = calls.filter((u) => u.includes('/rest/v1/rpc/'));
    expect(rpcCalls).toEqual(['https://test.supabase.co/rest/v1/rpc/admin_list_payout_exceptions']);
    vi.unstubAllGlobals();
  });

  it('a transfer Paystack failed or reversed is reported as consistent (not paid)', async () => {
    const rows = INCIDENT.slice(0, 2);
    const { fn } = stubFetch(rows, (code) => ({ ok: true, body: { data: { status: code.endsWith('0') ? 'failed' : 'reversed' } } }));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.json.mock.calls[0][0].report.map((r: any) => r.finding)).toEqual(['not_paid_consistent', 'not_paid_consistent']);
    vi.unstubAllGlobals();
  });

  it('a Paystack lookup failure is reported, not guessed', async () => {
    const { fn } = stubFetch(INCIDENT.slice(0, 1), () => ({ ok: false, body: { message: 'Transfer not found' } }));
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.json.mock.calls[0][0].report[0]).toMatchObject({ finding: 'paystack_lookup_failed', detail: 'Transfer not found' });
    vi.unstubAllGlobals();
  });

  it('a non-admin is refused before Paystack is ever called', async () => {
    const { fn, calls } = stubFetch([], () => ({ ok: true, body: {} }), 403);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(calls.some((u) => u.includes('api.paystack.co'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('without mode=exceptions the endpoint keeps its normal processing reconciliation', async () => {
    const { fn, calls } = stubFetch([], () => ({ ok: true, body: {} }));
    vi.stubGlobal('fetch', fn);
    await handler(req({}), makeRes());
    expect(calls.some((u) => u.includes('admin_list_processing_payouts'))).toBe(true);
    expect(calls.some((u) => u.includes('admin_list_payout_exceptions'))).toBe(false);
    vi.unstubAllGlobals();
  });
});
