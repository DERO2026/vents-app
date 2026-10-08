import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 7 -- proves the beta gate's wiring INTO aiAssistantHandler.ts:
// checked immediately after auth, before the per-user rate limit is
// consumed, before the kill switch, before entitlement checks, and
// before any Anthropic call -- a rejected (non-approved) account never
// reaches any of those, and never generates telemetry.

const {
  mockVerifyInsforgeSession,
  mockEnforceRateLimit,
  mockIsAiDisabled,
  mockIsAiEntitlementEnforced,
  mockCheckAndReserveAiUsage,
  mockBuildUserSupabaseClient,
  mockRecordAiUsageEvent,
  mockIsAiBetaUser,
} = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockIsAiDisabled: vi.fn(),
  mockIsAiEntitlementEnforced: vi.fn(),
  mockCheckAndReserveAiUsage: vi.fn(),
  mockBuildUserSupabaseClient: vi.fn((accessToken: string) => ({ __fakeClient: true, accessToken })),
  mockRecordAiUsageEvent: vi.fn(),
  mockIsAiBetaUser: vi.fn(),
}));

vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
  isAiDisabled: mockIsAiDisabled,
}));
vi.mock('../../api/_lib/aiEntitlement', () => ({
  isAiEntitlementEnforced: mockIsAiEntitlementEnforced,
  checkAndReserveAiUsage: mockCheckAndReserveAiUsage,
  AiEntitlementError: class AiEntitlementError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  },
}));
vi.mock('../../api/_lib/cors', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/aiConfirmation', () => ({ createConfirmationToken: vi.fn(), verifyConfirmationToken: vi.fn() }));
vi.mock('../../api/_lib/aiTools', () => ({
  ALL_TOOLS: [{ name: 'search_events' }],
  READ_ONLY_TOOL_NAMES: new Set(['search_events']),
  PROPOSAL_TOOL_NAMES: new Set(),
  PLAN_TOOL_NAMES: new Set(),
  WEB_SEARCH_TOOL: { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  WEB_SEARCH_TOOL_NAME: 'web_search',
  buildUserSupabaseClient: mockBuildUserSupabaseClient,
  executeReadOnlyTool: vi.fn(),
  executePlanTool: vi.fn(),
  buildProposal: vi.fn(),
  executeStartTicketTransfer: vi.fn(),
  executeRequestTicketRefund: vi.fn(),
  executeStartServiceBooking: vi.fn(),
  executeCreateReport: vi.fn(),
}));
vi.mock('../../api/_lib/aiTelemetry', () => ({
  newAiRequestId: () => 'fixed-round-id',
  recordAiUsageEvent: mockRecordAiUsageEvent,
}));
vi.mock('../../api/_lib/aiBeta', () => ({ isAiBetaUser: mockIsAiBetaUser }));

import { handleAiAssistant } from '../../api/_lib/aiAssistantHandler';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

const SESSION = { userId: 'user-1', email: 'user@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyInsforgeSession.mockResolvedValue(SESSION);
  mockEnforceRateLimit.mockResolvedValue(true);
  mockIsAiDisabled.mockResolvedValue(false);
  mockIsAiEntitlementEnforced.mockResolvedValue(false);
  mockCheckAndReserveAiUsage.mockResolvedValue({ allowed: true });
  mockIsAiBetaUser.mockResolvedValue(true); // default: approved, individual tests override
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('AI beta gate: approved account', () => {
  it('passes through to Anthropic and telemetry exactly as before the gate existed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 10 } }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(mockIsAiBetaUser).toHaveBeenCalledWith('user-1');
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(1);
  });
});

describe('AI beta gate: non-approved account', () => {
  it('rejects with 403 AI_BETA_RESTRICTED before touching Anthropic, rate limits, or telemetry', async () => {
    mockIsAiBetaUser.mockResolvedValueOnce(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'AI_BETA_RESTRICTED' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockIsAiDisabled).not.toHaveBeenCalled();
    expect(mockRecordAiUsageEvent).not.toHaveBeenCalled();
  });

  it('also rejects a confirmedAction request for a non-approved account -- the whole AI surface is gated, not just fresh chat', async () => {
    mockIsAiBetaUser.mockResolvedValueOnce(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { confirmedAction: { action: 'start_ticket_transfer', params: { ticketId: 'x' }, token: 'tok' } },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AI beta gate interacts correctly with existing controls', () => {
  it('kill switch still blocks an approved beta account -- the gate does not bypass it', async () => {
    mockIsAiBetaUser.mockResolvedValueOnce(true);
    mockIsAiDisabled.mockResolvedValueOnce(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('existing per-user rate limit still runs (and can still block) for an approved beta account', async () => {
    mockIsAiBetaUser.mockResolvedValueOnce(true);
    mockEnforceRateLimit.mockResolvedValueOnce(false);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(mockEnforceRateLimit).toHaveBeenCalledWith('Bearer tok', 'ai_assistant:user-1', 20, 3600);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('entitlement enforcement remains independently checked (and today a no-op) for an approved beta account', async () => {
    mockIsAiBetaUser.mockResolvedValueOnce(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 10 } }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());
    expect(mockIsAiEntitlementEnforced).toHaveBeenCalled();
  });

  it('unauthenticated requests are rejected by the existing auth check, before the beta gate is even reached', async () => {
    mockVerifyInsforgeSession.mockResolvedValueOnce(null);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer bad' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockIsAiBetaUser).not.toHaveBeenCalled();
  });
});
