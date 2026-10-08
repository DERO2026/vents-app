import { describe, it, expect, vi, beforeEach } from 'vitest';

// Billing-audit follow-up: the self-serve ticket-confirmation resend path
// (request_type: 'ticket' in status-email.ts) had NO server-side cooldown
// at all -- a signed-in caller could repeatedly trigger it and fan out to
// Resend (per attendee), Sendchamp SMS, generate_ticket_token, and a
// Storage upload every single time. These tests prove the new
// check_rate_limit-based gate actually blocks BEFORE any of that work, not
// merely in a client-side button state, and that it fails closed on any
// unexpected error -- same convention as verifyAccountRateLimit.security.test.ts
// in this same directory.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./mailer.js', () => ({
  sendOrganizerRequestDecisionEmail: vi.fn(),
  sendOrganizerVerificationDecisionEmail: vi.fn(),
  sendPayoutDecisionEmail: vi.fn(),
  sendVerifyAccountEmail: vi.fn(),
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

const SESSION = { userId: 'user-1', email: 'buyer@example.com' };
const TICKET_ROW = {
  id: 'ticket-1',
  ticket_type: 'Regular',
  holder_name: 'Buyer Name',
  holder_email: 'buyer@example.com',
  created_at: new Date().toISOString(),
  status: 'valid',
};

function makeFetchMock() {
  const calls: { url: string; init?: any }[] = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init });
    if (url.includes('/rest/v1/tickets')) {
      return { ok: true, json: async () => [TICKET_ROW] } as any;
    }
    if (url.includes('/rest/v1/events')) {
      return { ok: true, json: async () => [{ title: 'Test Event', event_date: new Date().toISOString(), location: 'Lagos' }] } as any;
    }
    if (url.includes('/rest/v1/users')) {
      return { ok: true, json: async () => [{ phone_number: null }] } as any;
    }
    if (url.includes('generate_ticket_token')) {
      return { ok: true, json: async () => 'signed-token-abc' } as any;
    }
    if (url.includes('/storage/v1/object/')) {
      return { ok: true, json: async () => ({}) } as any;
    }
    if (url.includes('api.resend.com')) {
      return { ok: true, text: async () => '' } as any;
    }
    if (url.includes('sendchamp.com') || url.includes('sendchamp')) {
      return { ok: true, text: async () => '' } as any;
    }
    return { ok: true, json: async () => ({}), text: async () => '' } as any;
  });
  return { fn, calls };
}

function req(body: any, authorization = 'Bearer tok') {
  return { method: 'POST', headers: { authorization }, body } as any;
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue(SESSION);
  process.env.VITE_SUPABASE_URL = 'https://proj.supabase.co';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
  process.env.RESEND_API_KEY = 'resend-key';
});

describe('ticket resend: rate limit gate', () => {
  it('1. first legitimate resend succeeds when the rate limit allows it', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.sent).toBe(true);
    vi.unstubAllGlobals();
  });

  it('2. immediate repeated resend (rate limit rejects) is rejected with 429', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    vi.unstubAllGlobals();
  });

  it('3. a rejected resend never calls Resend', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), makeRes());
    expect(calls.some((c) => c.url.includes('api.resend.com'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('4. a rejected resend never calls Sendchamp', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), makeRes());
    expect(calls.some((c) => c.url.includes('sendchamp'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('5. a rejected resend never performs the QR Storage upload or mints a ticket token', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const { fn, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), makeRes());
    expect(calls.some((c) => c.url.includes('/storage/v1/object/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('generate_ticket_token'))).toBe(false);
    // Nothing downstream ran at all -- not even the free ticket-lookup read.
    expect(calls.some((c) => c.url.includes('/rest/v1/tickets'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('6. the rate-limit key is scoped per user+event -- a different event_id is a different cooldown bucket', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-A' }), makeRes());
    await handler(req({ request_type: 'ticket', event_id: 'event-B' }), makeRes());
    const cooldownKeys = mockCallProjectAdminRpc.mock.calls
      .filter((c) => c[0] === 'check_rate_limit')
      .map((c) => c[1][0])
      .filter((k: string) => k.startsWith('ticket_resend_cooldown:'));
    expect(cooldownKeys).toContain('ticket_resend_cooldown:user-1:event-A');
    expect(cooldownKeys).toContain('ticket_resend_cooldown:user-1:event-B');
    expect(cooldownKeys[0]).not.toBe(cooldownKeys[1]);
    vi.unstubAllGlobals();
  });

  it('6b. a different user is a completely different cooldown+hourly bucket', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    mockVerifyInsforgeSession.mockResolvedValueOnce({ userId: 'user-2', email: 'other@example.com' });
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), makeRes());
    const keys = mockCallProjectAdminRpc.mock.calls.filter((c) => c[0] === 'check_rate_limit').map((c) => c[1][0]);
    expect(keys.some((k: string) => k.includes('user-2'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('7. enforcement happens server-side via check_rate_limit, not via any client-suppliable field', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    await handler(req({ request_type: 'ticket', event_id: 'event-1', skipRateLimit: true, rateLimitOk: true }), makeRes());
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['ticket_resend_cooldown:user-1:event-1', 1, 120]);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['ticket_resend_hourly:user-1', 5, 3600]);
    vi.unstubAllGlobals();
  });

  it('8. existing authentication behavior is intact -- no session still 401s, before the rate limit is even checked', async () => {
    mockVerifyInsforgeSession.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
  });

  it('9. existing successful resend response shape is unchanged', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const { fn } = makeFetchMock();
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ request_type: 'ticket', event_id: 'event-1' }), res);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({ sent: true, recipients: 1, delivered: 1 });
    expect(Array.isArray(body.results)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('ticket resend: Resend 429 retry can no longer create a cost-amplification loop', () => {
  it('10. a 429 from Resend is NOT retried -- exactly one call is made per recipient', async () => {
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
    const body = res.json.mock.calls[0][0];
    expect(body.delivered).toBe(0);
    vi.unstubAllGlobals();
  }, 10000);

  it('legitimate transient network failures still get one retry (unchanged behavior)', async () => {
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
    const body = res.json.mock.calls[0][0];
    expect(body.delivered).toBe(1);
    vi.unstubAllGlobals();
  }, 10000);
});
