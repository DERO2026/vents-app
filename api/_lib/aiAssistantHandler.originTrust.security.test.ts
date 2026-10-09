import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Audit finding F29 (MASTER_AUDIT.md): executeRequestTicketRefund's internal
// fetch target used to be built from req.headers['x-forwarded-proto'] /
// req.headers.host -- both attacker-controllable on an inbound request to a
// Vercel serverless function. Since that fetch carries the caller's own
// bearer token, a forged Host header could redirect it (with the token
// attached) to an attacker-chosen domain -- a real SSRF/open-redirect
// primitive, even though it could never leak ANOTHER user's token (the
// forged header and the token in one request necessarily belong to the same
// caller). Fixed in aiAssistantHandler.ts to use a trusted, server-configured
// origin (process.env.VITE_API_BASE, defaulting to the real production
// domain) instead of trusting any request header.
//
// This test proves the fix: a request carrying an attacker-controlled Host/
// X-Forwarded-Host (and every other header-spoofing variant) still resolves
// executeRequestTicketRefund's origin argument to the trusted value, never
// to the attacker's chosen domain -- and that a legitimate refund request
// (no funny headers at all) continues to work and uses the exact same
// trusted origin, proving the fix doesn't just move brokenness around.

const {
  mockVerifyInsforgeSession,
  mockEnforceRateLimit,
  mockVerifyConfirmationToken,
  mockExecuteRequestTicketRefund,
} = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockVerifyConfirmationToken: vi.fn(),
  mockExecuteRequestTicketRefund: vi.fn(),
}));

vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
  isAiDisabled: vi.fn(async () => false),
}));
vi.mock('../../api/_lib/cors', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/aiBeta', () => ({ isAiBetaUser: vi.fn(async () => true) }));
vi.mock('../../api/_lib/aiConfirmation', () => ({
  createConfirmationToken: vi.fn(() => 'signed-token'),
  verifyConfirmationToken: mockVerifyConfirmationToken,
}));
vi.mock('../../api/_lib/aiEntitlement', () => ({
  isAiEntitlementEnforced: vi.fn(async () => false),
  checkAndReserveAiUsage: vi.fn(),
  AiEntitlementError: class AiEntitlementError extends Error {},
}));
vi.mock('../../api/_lib/aiTools', () => ({
  ALL_TOOLS: [],
  READ_ONLY_TOOL_NAMES: new Set([]),
  PROPOSAL_TOOL_NAMES: new Set(['request_ticket_refund']),
  PLAN_TOOL_NAMES: new Set([]),
  WEB_SEARCH_TOOL: { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  WEB_SEARCH_TOOL_NAME: 'web_search',
  buildUserSupabaseClient: vi.fn(() => ({})),
  executeReadOnlyTool: vi.fn(),
  executeStartTicketTransfer: vi.fn(),
  executeRequestTicketRefund: mockExecuteRequestTicketRefund,
  executeStartServiceBooking: vi.fn(),
  executeCreateReport: vi.fn(),
}));

import { handleAiAssistant } from './aiAssistantHandler';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

const SESSION = { userId: 'user-1', email: 'user@example.com' };
const CONFIRMED_PARAMS = { ticket_id: 'ticket-123', reason: 'Event cancelled' };

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyInsforgeSession.mockResolvedValue(SESSION);
  mockEnforceRateLimit.mockResolvedValue(true);
  mockVerifyConfirmationToken.mockReturnValue({ ok: true });
  mockExecuteRequestTicketRefund.mockResolvedValue({ status: 'refund_pending' });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.VITE_API_BASE;
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.VITE_API_BASE;
});

function confirmedRefundRequest(headers: Record<string, string>) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer real-user-token', ...headers },
    body: {
      confirmedAction: { action: 'request_ticket_refund', params: CONFIRMED_PARAMS, token: 'tok' },
    },
  } as any;
}

describe('F29: executeRequestTicketRefund always uses a trusted origin, never a request header', () => {
  it('a forged Host header cannot redirect the internal refund fetch to an attacker domain', async () => {
    await handleAiAssistant(
      confirmedRefundRequest({ host: 'evil.attacker.example', 'x-forwarded-proto': 'http' }),
      makeRes()
    );

    expect(mockExecuteRequestTicketRefund).toHaveBeenCalledTimes(1);
    const [, originArg] = mockExecuteRequestTicketRefund.mock.calls[0];
    expect(originArg).toBe('https://getvents.com');
    expect(originArg).not.toContain('evil.attacker.example');
  });

  it('a forged X-Forwarded-Host header is equally ignored (not just the plain Host header)', async () => {
    await handleAiAssistant(
      confirmedRefundRequest({ host: 'getvents.com', 'x-forwarded-host': 'evil.attacker.example' }),
      makeRes()
    );

    const [, originArg] = mockExecuteRequestTicketRefund.mock.calls[0];
    expect(originArg).toBe('https://getvents.com');
  });

  it('a legitimate refund request with no unusual headers still works and resolves to the same trusted origin', async () => {
    const res = makeRes();
    await handleAiAssistant(confirmedRefundRequest({ host: 'getvents.com' }), res);

    expect(mockExecuteRequestTicketRefund).toHaveBeenCalledTimes(1);
    const [tokenArg, originArg, paramsArg] = mockExecuteRequestTicketRefund.mock.calls[0];
    expect(tokenArg).toBe('real-user-token');
    expect(originArg).toBe('https://getvents.com');
    expect(paramsArg).toEqual(CONFIRMED_PARAMS);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('honors a server-configured VITE_API_BASE override (e.g. a staging deployment) rather than hardcoding production unconditionally', async () => {
    process.env.VITE_API_BASE = 'https://staging.getvents.com';
    await handleAiAssistant(
      confirmedRefundRequest({ host: 'evil.attacker.example' }),
      makeRes()
    );

    const [, originArg] = mockExecuteRequestTicketRefund.mock.calls[0];
    expect(originArg).toBe('https://staging.getvents.com');
  });
});
