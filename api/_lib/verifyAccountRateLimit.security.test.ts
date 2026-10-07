import { describe, it, expect, vi, beforeEach } from 'vitest';

// Emergency cost-hardening pass (production billing audit): the
// verify_account branch of this endpoint is deliberately unauthenticated
// (fires pre-signup, before any session exists) and previously had NO rate
// limit at all -- a script could call it repeatedly with arbitrary email
// addresses to spend Resend sends at will. check_verify_account_rate_limit
// (0163_emergency_cost_hardening.sql) closes that, called over the trusted
// project_admin connection and FAILING CLOSED: any rejection from it must
// stop the send, never be treated as "allow by default".

const { mockCallProjectAdminRpc, mockSendVerifyAccountEmail } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockSendVerifyAccountEmail: vi.fn(async () => true),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./mailer.js', () => ({
  sendOrganizerRequestDecisionEmail: vi.fn(),
  sendOrganizerVerificationDecisionEmail: vi.fn(),
  sendPayoutDecisionEmail: vi.fn(),
  sendTicketRefundEmail: vi.fn(),
  sendVerifyAccountEmail: mockSendVerifyAccountEmail,
}));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: vi.fn() }));

import handler from '../notify/status-email';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockSendVerifyAccountEmail.mockClear();
});

describe('verify_account: rate limit', () => {
  it('checks the rate limit (keyed by the email) before sending', async () => {
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const req: any = { method: 'POST', headers: {}, body: { request_type: 'verify_account', email: 'user@example.com' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_verify_account_rate_limit', ['user@example.com']);
    expect(mockSendVerifyAccountEmail).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fails CLOSED: returns 429 and never sends when the limiter rejects', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const req: any = { method: 'POST', headers: {}, body: { request_type: 'verify_account', email: 'spammer@example.com' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockSendVerifyAccountEmail).not.toHaveBeenCalled();
  });

  it('fails CLOSED on any unexpected error from the limiter too, not just a genuine rate-limit hit', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated'));
    const req: any = { method: 'POST', headers: {}, body: { request_type: 'verify_account', email: 'user2@example.com' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockSendVerifyAccountEmail).not.toHaveBeenCalled();
  });

  it('never reveals backend/provider detail in the limited response', async () => {
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited'));
    const req: any = { method: 'POST', headers: {}, body: { request_type: 'verify_account', email: 'spammer@example.com' } };
    const res = makeRes();
    await handler(req, res);
    const jsonBody = res.json.mock.calls[0][0];
    expect(JSON.stringify(jsonBody)).not.toMatch(/resend|project_admin|postgres|sql/i);
  });
});
