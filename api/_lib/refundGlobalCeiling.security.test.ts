import { describe, it, expect, vi, beforeEach } from 'vitest';

// Paystack financial-exposure audit finding: refund-ticket.ts had no
// global ceiling on aggregate Paystack /refund volume across all
// authorized callers combined. These tests prove paystack_refund_global
// (100/hr) is checked only AFTER refund_ticket/cancel_service_booking's
// own authorization + state-transition RPC confirms a genuine
// 'refund_pending' case (so an unauthorized or ineligible call never
// consumes global refund capacity), strictly before the Paystack call,
// fails closed on any error, and releases the claimed state back rather
// than stranding it. No existing authorization/state/idempotency behavior
// is touched.

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));

import handler from '../wallet/refund-ticket';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

function req(body: any, authorization = 'Bearer tok') {
  return { method: 'POST', headers: { authorization }, body } as any;
}

const REFUND_BODY = { ticket_id: 'ticket-1', reason: 'Event cancelled' };
const PENDING_STATE = { status: 'refund_pending', payment_ref: 'pay-ref-1', amount_kobo: 50000 };

function makeFetchMock(opts: { startStatus?: any; refundOk?: boolean } = {}) {
  const calls: string[] = [];
  const startStatus = opts.startStatus ?? PENDING_STATE;
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/rpc/refund_ticket')) {
      return { ok: true, json: async () => ({ data: startStatus }) } as any;
    }
    if (url.includes('/rpc/admin_revert_stuck_refund')) {
      return { ok: true, json: async () => ({}) } as any;
    }
    if (url.includes('/rpc/attach_ticket_refund_id')) {
      return { ok: true, json: async () => ({}) } as any;
    }
    if (url.includes('api.paystack.co/refund')) {
      if (opts.refundOk === false) return { ok: false, json: async () => ({ status: false, message: 'Paystack error' }) } as any;
      return { ok: true, json: async () => ({ status: true, data: { id: 123 } }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  });
  return { fn, calls };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
  process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
});

describe('refund-ticket: global refund ceiling', () => {
  it('1. an authorized refund under the global limit proceeds to Paystack', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['paystack_refund_global', 100, 3600]);
    expect(calls.some((u) => u.includes('api.paystack.co/refund'))).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('2. global 100/hour reached rejects BEFORE Paystack, even for an otherwise-authorized refund', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(calls.some((u) => u.includes('api.paystack.co/refund'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('3. a global-limit RPC/infra failure (not a genuine hit) also fails CLOSED', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated'));
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(calls.some((u) => u.includes('api.paystack.co/refund'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('4. a rejected global check releases the claimed refund_pending state instead of stranding it', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req(REFUND_BODY), makeRes());
    expect(calls.some((u) => u.includes('/rpc/admin_revert_stuck_refund'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('5. an unauthorized/ineligible refund fails BEFORE the global check is ever reached -- it never consumes refund capacity', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const fn = vi.fn(async (url: string) => {
      if (url.includes('/rpc/refund_ticket')) {
        return { ok: false, status: 403, json: async () => ({ message: 'Not authorized' }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('6. a free ticket (status already "refunded") short-circuits before the global check -- no capacity consumed', async () => {
    const { fn } = makeFetchMock({ startStatus: { status: 'refunded' } });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('7. a repeat call after the refund already finished ("already_refunded") remains idempotent, unaffected by the global check', async () => {
    const { fn } = makeFetchMock({ startStatus: { status: 'already_refunded' } });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({ status: 'already_refunded' });
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('8. existing Paystack-rejection revert behavior is unchanged when the global check passes', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn, calls } = makeFetchMock({ refundOk: false });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req(REFUND_BODY), res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(calls.some((u) => u.includes('/rpc/admin_revert_stuck_refund'))).toBe(true);
    vi.unstubAllGlobals();
  });
});
