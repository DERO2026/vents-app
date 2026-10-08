import { describe, it, expect, vi, beforeEach } from 'vitest';

// Resend/Sendchamp billing audit finding: every send path in status-email.ts
// already had a per-user (or per-email) ceiling, but nothing capped
// AGGREGATE volume across all callers combined. These tests prove the three
// new global ceilings (ticket_resend_global, verify_account_global,
// admin_notification_global) actually gate BEFORE any provider call, fail
// closed on any RPC error (not just a genuine limit hit), and leave every
// pre-existing per-user/per-email/admin-authorization check fully intact --
// selectively rejecting only the global key proves the global check is an
// ADDITIONAL gate, not a replacement for the existing ones.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession, mockSendVerifyAccountEmail } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
  mockSendVerifyAccountEmail: vi.fn(async () => true),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./mailer.js', () => ({
  sendOrganizerRequestDecisionEmail: vi.fn(async () => true),
  sendOrganizerVerificationDecisionEmail: vi.fn(async () => true),
  sendPayoutDecisionEmail: vi.fn(async () => true),
  sendTicketRefundEmail: vi.fn(async () => true),
  sendVerifyAccountEmail: mockSendVerifyAccountEmail,
}));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: mockVerifyInsforgeSession }));

import handler from '../notify/status-email';

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

const SESSION = { userId: 'user-1', email: 'buyer@example.com' };
const TICKET_ROW = {
  id: 'ticket-1', ticket_type: 'Regular', holder_name: 'Buyer Name',
  holder_email: 'buyer@example.com', created_at: new Date().toISOString(), status: 'valid',
};

function makeTicketFetchMock() {
  const calls: { url: string }[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push({ url });
    if (url.includes('/rest/v1/tickets')) return { ok: true, json: async () => [TICKET_ROW] } as any;
    if (url.includes('/rest/v1/events')) return { ok: true, json: async () => [{ title: 'Test Event', event_date: new Date().toISOString(), location: 'Lagos' }] } as any;
    if (url.includes('/rest/v1/users')) return { ok: true, json: async () => [{ phone_number: null }] } as any;
    if (url.includes('generate_ticket_token')) return { ok: true, json: async () => 'signed-token-abc' } as any;
    if (url.includes('/storage/v1/object/')) return { ok: true, json: async () => ({}) } as any;
    if (url.includes('api.resend.com')) return { ok: true, text: async () => '' } as any;
    if (url.includes('sendchamp')) return { ok: true, text: async () => '' } as any;
    return { ok: true, json: async () => ({}), text: async () => '' } as any;
  });
  return { fn, calls };
}

// Only the named key rejects -- every other check_rate_limit call succeeds.
// Lets a test isolate the NEW global check from the pre-existing ones.
function rejectOnlyKey(rejectKey: string) {
  mockCallProjectAdminRpc.mockImplementation(async (fnName: string, args: any[]) => {
    if (fnName === 'check_rate_limit' && args[0] === rejectKey) throw new Error('rate_limited');
    return undefined;
  });
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue(SESSION);
  mockSendVerifyAccountEmail.mockClear();
  process.env.VITE_SUPABASE_URL = 'https://proj.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  process.env.RESEND_API_KEY = 'resend-key';
  process.env.SENDCHAMP_API_KEY = 'sendchamp-key';
});

describe('ticket resend: global ceiling', () => {
  it('1. under the global limit, the existing per-user flow still succeeds', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makeTicketFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['ticket_resend_global', 500, 3600]);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('2. global limit reached rejects with 429 even though per-user checks would have passed', async () => {
    rejectOnlyKey('ticket_resend_global');
    const { fn } = makeTicketFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('3. a global-limit infra/RPC error (not a genuine hit) also fails CLOSED', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string, args: any[]) => {
      if (fnName === 'check_rate_limit' && args[0] === 'ticket_resend_global') throw new Error('connection terminated');
      return undefined;
    });
    const { fn } = makeTicketFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('4. existing per-user+event cooldown is checked and still works (not bypassed by the global check)', async () => {
    rejectOnlyKey('ticket_resend_cooldown:user-1:event-1');
    const { fn } = makeTicketFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('5. existing per-user hourly ceiling is checked and still works (not bypassed by the global check)', async () => {
    rejectOnlyKey('ticket_resend_hourly:user-1');
    const { fn } = makeTicketFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('6. a rejected global check never calls Resend or Sendchamp, or performs downstream work', async () => {
    rejectOnlyKey('ticket_resend_global');
    const { fn, calls } = makeTicketFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), makeRes());
    expect(calls.some((c) => c.url.includes('api.resend.com'))).toBe(false);
    expect(calls.some((c) => c.url.includes('sendchamp'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/storage/v1/object/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('generate_ticket_token'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/rest/v1/tickets'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('7. a 429 from Resend is still not retried, with the new global check passing', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    let resendCallCount = 0;
    const fn = vi.fn(async (url: string) => {
      if (url.includes('/rest/v1/tickets')) return { ok: true, json: async () => [TICKET_ROW] } as any;
      if (url.includes('/rest/v1/events')) return { ok: true, json: async () => [{ title: 'Test Event', event_date: new Date().toISOString(), location: 'Lagos' }] } as any;
      if (url.includes('/rest/v1/users')) return { ok: true, json: async () => [{ phone_number: null }] } as any;
      if (url.includes('generate_ticket_token')) return { ok: true, json: async () => 'signed-token-abc' } as any;
      if (url.includes('/storage/v1/object/')) return { ok: true, json: async () => ({}) } as any;
      if (url.includes('api.resend.com')) { resendCallCount++; return { ok: false, status: 429, text: async () => 'rate limited' } as any; }
      return { ok: true, json: async () => ({}), text: async () => '' } as any;
    });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(resendCallCount).toBe(1);
    vi.unstubAllGlobals();
  }, 10000);

  it('8. a transient Resend network error still gets exactly one retry, with the new global check passing', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    let resendCallCount = 0;
    const fn = vi.fn(async (url: string) => {
      if (url.includes('/rest/v1/tickets')) return { ok: true, json: async () => [TICKET_ROW] } as any;
      if (url.includes('/rest/v1/events')) return { ok: true, json: async () => [{ title: 'Test Event', event_date: new Date().toISOString(), location: 'Lagos' }] } as any;
      if (url.includes('/rest/v1/users')) return { ok: true, json: async () => [{ phone_number: null }] } as any;
      if (url.includes('generate_ticket_token')) return { ok: true, json: async () => 'signed-token-abc' } as any;
      if (url.includes('/storage/v1/object/')) return { ok: true, json: async () => ({}) } as any;
      if (url.includes('api.resend.com')) {
        resendCallCount++;
        if (resendCallCount === 1) throw new Error('ECONNRESET');
        return { ok: true, text: async () => '' } as any;
      }
      return { ok: true, json: async () => ({}), text: async () => '' } as any;
    });
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(resendCallCount).toBe(2);
    vi.unstubAllGlobals();
  }, 10000);

  it('9. Sendchamp remains behind the same gates -- a passing request still fires the SMS check', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const fn = vi.fn(async (url: string) => {
      if (url.includes('/rest/v1/tickets')) return { ok: true, json: async () => [TICKET_ROW] } as any;
      if (url.includes('/rest/v1/events')) return { ok: true, json: async () => [{ title: 'Test Event', event_date: new Date().toISOString(), location: 'Lagos' }] } as any;
      if (url.includes('/rest/v1/users')) return { ok: true, json: async () => [{ phone_number: '+2348000000000' }] } as any;
      if (url.includes('generate_ticket_token')) return { ok: true, json: async () => 'signed-token-abc' } as any;
      if (url.includes('/storage/v1/object/')) return { ok: true, json: async () => ({}) } as any;
      if (url.includes('api.resend.com')) return { ok: true, text: async () => '' } as any;
      if (url.includes('sendchamp')) return { ok: true, text: async () => '' } as any;
      return { ok: true, json: async () => ({}), text: async () => '' } as any;
    });
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), makeRes());
    // Give the fire-and-forget SMS promise chain (fetch -> .then -> .then)
    // enough ticks to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(fn.mock.calls.some((c) => String(c[0]).includes('sendchamp'))).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('verify_account: global ceiling', () => {
  function verifyReq(email: string) {
    return { method: 'POST', headers: {}, body: { request_type: 'verify_account', email } } as any;
  }

  it('1. under the global limit, the existing per-email flow still succeeds', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const res = makeRes();
    await handler(verifyReq('user@example.com'), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_verify_account_rate_limit', ['user@example.com']);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['verify_account_global', 500, 3600]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSendVerifyAccountEmail).toHaveBeenCalled();
  });

  it('2. global limit reached rejects with 429 even though the per-email check would have passed', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string) => {
      if (fnName === 'check_rate_limit') throw new Error('rate_limited');
      return undefined; // check_verify_account_rate_limit still succeeds
    });
    const res = makeRes();
    await handler(verifyReq('user@example.com'), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockSendVerifyAccountEmail).not.toHaveBeenCalled();
  });

  it('3. a global-limit RPC/infra error also fails CLOSED', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string) => {
      if (fnName === 'check_rate_limit') throw new Error('connection terminated');
      return undefined;
    });
    const res = makeRes();
    await handler(verifyReq('user@example.com'), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockSendVerifyAccountEmail).not.toHaveBeenCalled();
  });

  it('4. the existing per-email protection remains intact -- it still rejects independent of the global check', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string) => {
      if (fnName === 'check_verify_account_rate_limit') throw new Error('rate_limited');
      return undefined; // global check would have passed
    });
    const res = makeRes();
    await handler(verifyReq('spammer@example.com'), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockSendVerifyAccountEmail).not.toHaveBeenCalled();
  });
});

describe('admin notifications: global ceiling', () => {
  function adminReq(overrides: any = {}) {
    return req({ request_type: 'organizer', request_id: 'req-1', decision: 'approved', ...overrides });
  }

  function makeAdminFetchMock(isAdmin: boolean) {
    return vi.fn(async (url: string) => {
      if (url.includes('/rpc/is_admin')) return { ok: true, json: async () => isAdmin } as any;
      if (url.includes('organizer_requests')) return { ok: true, json: async () => [{ user_id: 'organizer-1' }] } as any;
      if (url.includes('/rest/v1/users')) return { ok: true, json: async () => [{ full_name: 'Org Name', email: 'organizer@example.com', phone_number: null }] } as any;
      return { ok: true, json: async () => ({}) } as any;
    });
  }

  it('1. a non-admin caller is still rejected before the global check is even reached', async () => {
    mockVerifyInsforgeSession.mockResolvedValue(SESSION);
    vi.stubGlobal('fetch', makeAdminFetchMock(false));
    const res = makeRes();
    await handler(adminReq(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalledWith('check_rate_limit', ['admin_notification_global', expect.anything(), expect.anything()]);
    vi.unstubAllGlobals();
  });

  it('2. an admin under the global limit succeeds', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', makeAdminFetchMock(true));
    const res = makeRes();
    await handler(adminReq(), res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['admin_notification_global', 500, 3600]);
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it('3. global limit reached rejects with 429 even for a verified admin', async () => {
    rejectOnlyKey('admin_notification_global');
    vi.stubGlobal('fetch', makeAdminFetchMock(true));
    const res = makeRes();
    await handler(adminReq(), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('4. a global-limit RPC/infra error also fails CLOSED for an admin', async () => {
    mockCallProjectAdminRpc.mockImplementation(async (fnName: string, args: any[]) => {
      if (fnName === 'check_rate_limit' && args[0] === 'admin_notification_global') throw new Error('connection terminated');
      return undefined;
    });
    vi.stubGlobal('fetch', makeAdminFetchMock(true));
    const res = makeRes();
    await handler(adminReq(), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });
});
