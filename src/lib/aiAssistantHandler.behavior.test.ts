import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Behavioral tests for api/_lib/aiAssistantHandler.ts -- the handler that
// used to be api/ai-assistant.ts's own default export, moved here (and now
// invoked as a branch of api/extract-events.ts) purely to stay within Vercel
// Hobby's 12-serverless-function cap. Nothing about its own auth, rate
// limiting, RLS-scoped tool execution, or confirm-then-execute flow should
// have changed in that move -- these tests prove that behavior directly.

const {
  mockVerifyInsforgeSession,
  mockEnforceRateLimit,
  mockVerifyConfirmationToken,
  mockCreateConfirmationToken,
  mockBuildUserSupabaseClient,
  mockExecuteReadOnlyTool,
  mockBuildProposal,
  mockExecuteStartTicketTransfer,
  mockExecuteRequestTicketRefund,
  mockExecuteStartServiceBooking,
  mockExecuteCreateReport,
} = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockVerifyConfirmationToken: vi.fn(),
  mockCreateConfirmationToken: vi.fn(() => 'signed-token'),
  mockBuildUserSupabaseClient: vi.fn((accessToken: string) => ({ __fakeClient: true, accessToken })),
  mockExecuteReadOnlyTool: vi.fn(),
  mockBuildProposal: vi.fn((name: string, input: any) => ({ proposal: { action: name, ...input } })),
  mockExecuteStartTicketTransfer: vi.fn(),
  mockExecuteRequestTicketRefund: vi.fn(),
  mockExecuteStartServiceBooking: vi.fn(),
  mockExecuteCreateReport: vi.fn(),
}));

vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
}));
vi.mock('../../api/_lib/cors', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/aiConfirmation', () => ({
  createConfirmationToken: mockCreateConfirmationToken,
  verifyConfirmationToken: mockVerifyConfirmationToken,
}));
vi.mock('../../api/_lib/aiTools', () => ({
  ALL_TOOLS: [{ name: 'search_events' }, { name: 'start_ticket_transfer' }],
  READ_ONLY_TOOL_NAMES: new Set(['search_events']),
  PROPOSAL_TOOL_NAMES: new Set(['start_ticket_transfer', 'request_ticket_refund', 'start_service_booking', 'create_report']),
  WEB_SEARCH_TOOL: { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  WEB_SEARCH_TOOL_NAME: 'web_search',
  buildUserSupabaseClient: mockBuildUserSupabaseClient,
  executeReadOnlyTool: mockExecuteReadOnlyTool,
  buildProposal: mockBuildProposal,
  executeStartTicketTransfer: mockExecuteStartTicketTransfer,
  executeRequestTicketRefund: mockExecuteRequestTicketRefund,
  executeStartServiceBooking: mockExecuteStartServiceBooking,
  executeCreateReport: mockExecuteCreateReport,
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
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('handleAiAssistant: auth gating', () => {
  it('requires verifyInsforgeSession and returns 401 when it fails', async () => {
    mockVerifyInsforgeSession.mockResolvedValueOnce(null);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer bad' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(mockVerifyInsforgeSession).toHaveBeenCalledWith('Bearer bad');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('enforces the rate limit and returns 429 when exceeded', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(false);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith('Bearer tok', 'ai_assistant:user-1', 20, 3600);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('rejects non-POST, non-OPTIONS methods', async () => {
    const req: any = { method: 'GET', headers: {}, body: {} };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});

describe('handleAiAssistant: tool session forwarding (no service-role)', () => {
  it('builds the Supabase client from the caller\'s own forwarded access token, never a service-role key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'hello' }] }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer user-access-token' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(mockBuildUserSupabaseClient).toHaveBeenCalledWith('user-access-token');
  });

  it('executes read-only tool_use blocks via executeReadOnlyTool with the forwarded client, and reports results as vents-sourced cards', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: 'tool_use', id: 'tu1', name: 'search_events', input: { query: 'afrobeats' } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Found some events.' }] }) };
    }));
    mockExecuteReadOnlyTool.mockResolvedValueOnce([{ id: 'evt1', title: 'Afrobeats Night' }]);

    const req: any = { method: 'POST', headers: { authorization: 'Bearer user-access-token' }, body: { messages: [{ role: 'user', content: 'find afrobeats events' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(mockExecuteReadOnlyTool).toHaveBeenCalledWith('search_events', { __fakeClient: true, accessToken: 'user-access-token' }, { query: 'afrobeats' });
    const jsonBody = res.json.mock.calls[0][0];
    expect(jsonBody.type).toBe('message');
    expect(jsonBody.cards).toEqual([{ type: 'search_events', data: [{ id: 'evt1', title: 'Afrobeats Night' }], source: 'vents' }]);
  });
});

describe('handleAiAssistant: Phase 2 explain -> confirm -> execute (no mutating tool executes inline)', () => {
  it('never executes a proposal tool inside the model loop -- it mints a confirmation token and returns confirmation_required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'I can transfer that ticket for you.' },
          { type: 'tool_use', id: 'tu1', name: 'start_ticket_transfer', input: { ticket_id: 't1', recipient_identifier: 'a@b.com' } },
        ],
      }),
    })));

    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'transfer my ticket to a@b.com' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(mockExecuteStartTicketTransfer).not.toHaveBeenCalled();
    expect(mockCreateConfirmationToken).toHaveBeenCalledWith('start_ticket_transfer', { ticket_id: 't1', recipient_identifier: 'a@b.com' }, 'user-1');
    const jsonBody = res.json.mock.calls[0][0];
    expect(jsonBody.type).toBe('confirmation_required');
    expect(jsonBody.token).toBe('signed-token');
  });

  it('rejects a confirmedAction for an action that is not a known proposal tool', async () => {
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { confirmedAction: { action: 'delete_everything', params: {}, token: 'x' } },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockVerifyConfirmationToken).not.toHaveBeenCalled();
  });

  it('rejects a confirmedAction whose token fails verification, without executing anything', async () => {
    mockVerifyConfirmationToken.mockReturnValueOnce({ ok: false, reason: 'invalid signature' });
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { confirmedAction: { action: 'start_ticket_transfer', params: { ticket_id: 't1', recipient_identifier: 'a@b.com' }, token: 'bad' } },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(mockExecuteStartTicketTransfer).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('a verified confirmedAction executes the real Phase 2 executor with the forwarded user client, and reports the real result', async () => {
    mockVerifyConfirmationToken.mockReturnValueOnce({ ok: true });
    mockExecuteStartTicketTransfer.mockResolvedValueOnce({ transfer_id: 'xfer_1' });

    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer user-access-token' },
      body: { confirmedAction: { action: 'start_ticket_transfer', params: { ticket_id: 't1', recipient_identifier: 'a@b.com' }, token: 'good' } },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);

    expect(mockExecuteStartTicketTransfer).toHaveBeenCalledWith(
      { __fakeClient: true, accessToken: 'user-access-token' },
      { ticket_id: 't1', recipient_identifier: 'a@b.com' }
    );
    const jsonBody = res.json.mock.calls[0][0];
    expect(jsonBody.type).toBe('message');
    expect(jsonBody.cards[0]).toEqual({ type: 'start_ticket_transfer', data: { transfer_id: 'xfer_1' }, source: 'vents' });
  });
});

describe('handleAiAssistant: web_search error-shape handling', () => {
  it('treats a non-array web_search_tool_result content as an error card (Anthropic returns HTTP 200 either way)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } },
          { type: 'text', text: 'done' },
        ],
      }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'search something' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    const jsonBody = res.json.mock.calls[0][0];
    expect(jsonBody.cards).toContainEqual({ type: 'web_search_error', data: { error_code: 'max_uses_exceeded' }, source: 'external' });
  });

  it('treats an array web_search_tool_result content as a successful external-sourced card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          { type: 'web_search_tool_result', content: [{ title: 'Some Concert', url: 'https://example.com' }] },
          { type: 'text', text: 'done' },
        ],
      }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'search something' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    const jsonBody = res.json.mock.calls[0][0];
    expect(jsonBody.cards).toContainEqual({ type: 'web_search', data: [{ title: 'Some Concert', url: 'https://example.com' }], source: 'external' });
  });
});
