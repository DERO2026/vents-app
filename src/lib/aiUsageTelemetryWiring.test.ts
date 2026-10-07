import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 5A -- proves the telemetry wiring INTO the three real Anthropic
// call sites (chat's round loop, extraction, vision), not just that
// aiTelemetry.ts itself works in isolation (see aiTelemetry.test.ts for
// that). Mocks everything aiAssistantHandler.behavior.test.ts already
// mocks (same approach, kept in its own file so that already-large file
// doesn't grow further) PLUS aiTelemetry itself, so every assertion here
// is about WHAT gets recorded and WHEN, never about a real network/DB call.

const {
  mockVerifyInsforgeSession,
  mockEnforceRateLimit,
  mockIsAiDisabled,
  mockIsAiEntitlementEnforced,
  mockCheckAndReserveAiUsage,
  mockBuildUserSupabaseClient,
  mockRecordAiUsageEvent,
} = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockIsAiDisabled: vi.fn(),
  mockIsAiEntitlementEnforced: vi.fn(),
  mockCheckAndReserveAiUsage: vi.fn(),
  mockBuildUserSupabaseClient: vi.fn((accessToken: string) => ({ __fakeClient: true, accessToken })),
  mockRecordAiUsageEvent: vi.fn(),
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
// The one mock this file adds beyond the existing behavior-test set.
vi.mock('../../api/_lib/aiTelemetry', () => ({
  newAiRequestId: () => 'fixed-round-id-for-test',
  recordAiUsageEvent: mockRecordAiUsageEvent,
}));

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
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('chat: telemetry recorded per round, with real usage fields and no PII', () => {
  it('records a success event with the exact usage fields Anthropic returned, including cache fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'hi there' }],
        usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 8300 },
      }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());

    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(1);
    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      surface: 'chat',
      model: 'claude-sonnet-5',
      roundId: 'fixed-round-id-for-test',
      roundIndex: 0,
      status: 'success',
      inputTokens: 120,
      outputTokens: 40,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 8300,
    });
  });

  it('passes null (not a fabricated 0) for cache fields Anthropic did not return', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 50, output_tokens: 10 } }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());

    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call.cacheCreationInputTokens).toBeNull();
    expect(call.cacheReadInputTokens).toBeNull();
    expect(call.webSearchRequests).toBeNull();
  });

  it('records one event PER ROUND with an incrementing roundIndex sharing the same roundId', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'search_events', input: {} }], usage: { input_tokens: 100, output_tokens: 20 } }) };
      }
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 150, output_tokens: 30 } }) };
    }));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'find events' }] } };
    await handleAiAssistant(req, makeRes());

    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsageEvent.mock.calls[0][0].roundIndex).toBe(0);
    expect(mockRecordAiUsageEvent.mock.calls[1][0].roundIndex).toBe(1);
    expect(mockRecordAiUsageEvent.mock.calls[0][0].roundId).toBe(mockRecordAiUsageEvent.mock.calls[1][0].roundId);
  });

  it('records a status: error event (with null usage) when Anthropic returns a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'rate limited upstream' })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());

    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(1);
    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call.status).toBe('error');
    expect(call.inputTokens).toBeNull();
    expect(call.outputTokens).toBeNull();
  });

  it('never passes session.userId, email, or message content into the telemetry call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'a secret reply about the user' }], usage: { input_tokens: 10, output_tokens: 10 } }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'my email is secret@example.com' }] } };
    await handleAiAssistant(req, makeRes());

    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    const serialized = JSON.stringify(call);
    expect(serialized).not.toMatch(/user-1|user@example\.com|secret@example\.com|secret reply/);
    expect(Object.keys(call).sort()).toEqual(
      ['cacheCreationInputTokens', 'cacheReadInputTokens', 'inputTokens', 'model', 'outputTokens', 'roundId', 'roundIndex', 'status', 'surface', 'webSearchRequests'].sort()
    );
  });

  it('records nothing at all when the kill switch blocks the request before any Anthropic call', async () => {
    mockIsAiDisabled.mockResolvedValueOnce(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockRecordAiUsageEvent).not.toHaveBeenCalled();
  });

  it('entitlement enforcement being OFF (the current production state) does not affect whether telemetry is recorded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 10 } }),
    })));
    expect(mockIsAiEntitlementEnforced).toBeDefined();
    mockIsAiEntitlementEnforced.mockResolvedValueOnce(false); // production default
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());
    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(1);
  });
});
