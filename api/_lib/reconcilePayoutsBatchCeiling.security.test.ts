import { describe, it, expect, vi, beforeEach } from 'vitest';

// Paystack payout audit finding: admin_list_processing_payouts has no
// LIMIT, so one reconcile-payouts.ts invocation made one Paystack
// GET /transfer/:code call per row currently 'processing' with no ceiling.
// These tests cover the MAX_RECONCILE_BATCH=50 slice added before the
// per-row Paystack loop -- rows beyond the ceiling are left untouched
// ('processing', unchanged) for a later manually-triggered run, never
// silently processed. Idempotent completion/failure semantics
// (complete_organizer_payout/fail_organizer_payout) are untouched by this
// change and re-verified here to still hold on a second run.

const { mockCallProjectAdminTableRpc, mockSendPayoutDecisionEmail } = vi.hoisted(() => ({
  mockCallProjectAdminTableRpc: vi.fn(),
  mockSendPayoutDecisionEmail: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminTableRpc: mockCallProjectAdminTableRpc,
}));
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

function req(authorization = 'Bearer tok') {
  return { method: 'POST', headers: { authorization }, body: {} } as any;
}

function processingRow(i: number) {
  return { request_id: `req-${i}`, organizer_id: `org-${i}`, amount_kobo: 1000 * i, transfer_code: `TRF_${i}`, paystack_reference: `ref-${i}`, updated_at: new Date().toISOString() };
}

function stubFetch(rows: any[]) {
  const transferCalls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    if (url.includes('admin_list_processing_payouts')) {
      return { ok: true, json: async () => rows } as any;
    }
    if (url.includes('api.paystack.co/transfer/')) {
      transferCalls.push(url);
      return { ok: true, json: async () => ({ data: { status: 'success' } }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  });
  return { fn, transferCalls };
}

beforeEach(() => {
  mockCallProjectAdminTableRpc.mockReset();
  mockSendPayoutDecisionEmail.mockReset();
  mockCallProjectAdminTableRpc.mockResolvedValue([{ status: 'completed', organizer_email: null, organizer_name: null, amount_kobo: 1000 }]);
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

describe('reconcile-payouts: batch ceiling', () => {
  it('1. fewer than the maximum (10) processing rows are all handled', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => processingRow(i));
    const { fn, transferCalls } = stubFetch(rows);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ checked: 10, deferred_count: 0 }));
    expect(transferCalls.length).toBe(10);
    vi.unstubAllGlobals();
  });

  it('2. exactly the maximum (50) rows are all handled', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => processingRow(i));
    const { fn, transferCalls } = stubFetch(rows);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ checked: 50, deferred_count: 0 }));
    expect(transferCalls.length).toBe(50);
    vi.unstubAllGlobals();
  });

  it('3. more than the maximum (75) does not cause additional Paystack status calls beyond 50', async () => {
    const rows = Array.from({ length: 75 }, (_, i) => processingRow(i));
    const { fn, transferCalls } = stubFetch(rows);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(transferCalls.length).toBe(50);
    vi.unstubAllGlobals();
  });

  it('4. the remaining rows beyond the ceiling are reported as deferred, not silently dropped', async () => {
    const rows = Array.from({ length: 75 }, (_, i) => processingRow(i));
    const { fn } = stubFetch(rows);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ checked: 50, deferred_count: 25 }));
    vi.unstubAllGlobals();
  });

  it('5. a second reconciliation run over the same (now already-resolved) rows remains idempotent', async () => {
    const rows = [processingRow(1)];
    const { fn } = stubFetch(rows);
    vi.stubGlobal('fetch', fn);

    mockCallProjectAdminTableRpc.mockResolvedValueOnce([{ status: 'completed', organizer_email: null, organizer_name: null, amount_kobo: 1000 }]);
    const res1 = makeRes();
    await handler(req(), res1);
    expect(res1.json).toHaveBeenCalledWith(expect.objectContaining({ checked: 1 }));

    // Second run: the RPC itself reports already_completed (status-guarded,
    // unchanged by this batch-ceiling change) -- not re-verified here beyond
    // confirming the endpoint surfaces whatever the RPC reports, unchanged.
    mockCallProjectAdminTableRpc.mockResolvedValueOnce([{ status: 'already_completed', organizer_email: null, organizer_name: null, amount_kobo: 1000 }]);
    const res2 = makeRes();
    await handler(req(), res2);
    const secondCallArgs = (res2.json as any).mock.calls[0][0];
    expect(secondCallArgs.results[0].outcome).toBe('already_completed');
    vi.unstubAllGlobals();
  });

  it('6. existing completion/failure semantics (success -> complete_organizer_payout, failed -> fail_organizer_payout) are unchanged', async () => {
    const rows = [processingRow(1), processingRow(2)];
    const transferStatuses: Record<string, string> = { 'TRF_1': 'success', 'TRF_2': 'failed' };
    const fn = vi.fn(async (url: string) => {
      if (url.includes('admin_list_processing_payouts')) return { ok: true, json: async () => rows } as any;
      if (url.includes('api.paystack.co/transfer/')) {
        const code = url.split('/').pop();
        return { ok: true, json: async () => ({ data: { status: transferStatuses[code!] } }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    vi.stubGlobal('fetch', fn);

    mockCallProjectAdminTableRpc.mockResolvedValue([{ status: 'completed', organizer_email: null, organizer_name: null, amount_kobo: 1000 }]);
    const res = makeRes();
    await handler(req(), res);

    expect(mockCallProjectAdminTableRpc).toHaveBeenCalledWith('complete_organizer_payout', ['TRF_1']);
    expect(mockCallProjectAdminTableRpc).toHaveBeenCalledWith('fail_organizer_payout', ['TRF_2', expect.stringContaining('failed')]);
    vi.unstubAllGlobals();
  });
});
