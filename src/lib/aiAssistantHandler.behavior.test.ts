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
  mockIsAiDisabled,
  mockVerifyConfirmationToken,
  mockCreateConfirmationToken,
  mockBuildUserSupabaseClient,
  mockExecuteReadOnlyTool,
  mockExecutePlanTool,
  mockBuildProposal,
  mockExecuteStartTicketTransfer,
  mockExecuteRequestTicketRefund,
  mockExecuteStartServiceBooking,
  mockExecuteCreateReport,
} = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockIsAiDisabled: vi.fn(),
  mockVerifyConfirmationToken: vi.fn(),
  mockCreateConfirmationToken: vi.fn(() => 'signed-token'),
  mockBuildUserSupabaseClient: vi.fn((accessToken: string) => ({ __fakeClient: true, accessToken })),
  mockExecuteReadOnlyTool: vi.fn(),
  mockExecutePlanTool: vi.fn(),
  mockBuildProposal: vi.fn((name: string, input: any) => ({ proposal: { action: name, ...input } })),
  mockExecuteStartTicketTransfer: vi.fn(),
  mockExecuteRequestTicketRefund: vi.fn(),
  mockExecuteStartServiceBooking: vi.fn(),
  mockExecuteCreateReport: vi.fn(),
}));

vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
  isAiDisabled: mockIsAiDisabled,
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
  PLAN_TOOL_NAMES: new Set(['get_plan']),
  WEB_SEARCH_TOOL: { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  WEB_SEARCH_TOOL_NAME: 'web_search',
  buildUserSupabaseClient: mockBuildUserSupabaseClient,
  executeReadOnlyTool: mockExecuteReadOnlyTool,
  executePlanTool: mockExecutePlanTool,
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
  mockIsAiDisabled.mockResolvedValue(false);
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

// Emergency cost-hardening pass (production billing audit): the master
// Anthropic kill switch, a hard per-message length cap, and a server-side
// conversation-history cap. These prove the actual behavior, not just that
// the mocks were called -- in particular that NO fetch to Anthropic ever
// happens when the switch is off, and that the history sent upstream is
// actually trimmed server-side regardless of what the client sent.
describe('handleAiAssistant: emergency kill switch and cost ceilings', () => {
  it('blocks the request with 503 and never calls Anthropic when the kill switch is on', async () => {
    mockIsAiDisabled.mockResolvedValueOnce(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'AI_UNAVAILABLE' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never leaks the API key or raw Anthropic error detail in the kill-switch response', async () => {
    mockIsAiDisabled.mockResolvedValueOnce(true);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    const jsonBody = res.json.mock.calls[0][0];
    expect(JSON.stringify(jsonBody)).not.toMatch(/test-key|sk-ant|anthropic\.com/i);
  });

  it('still allows confirming an already-proposed action while the kill switch is on (no new Anthropic call needed)', async () => {
    mockIsAiDisabled.mockResolvedValueOnce(true);
    mockVerifyConfirmationToken.mockReturnValueOnce({ ok: true });
    mockExecuteStartTicketTransfer.mockResolvedValueOnce({ transfer_id: 't1' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { confirmedAction: { action: 'start_ticket_transfer', params: { ticketId: 'x' }, token: 'tok' } },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockExecuteStartTicketTransfer).toHaveBeenCalled();
  });

  it('rejects a single message over the hard length cap with 400, before any Anthropic call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [{ role: 'user', content: 'x'.repeat(4001) }] },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a message right at the length cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) })));
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [{ role: 'user', content: 'x'.repeat(4000) }] },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('trims conversation history server-side to the most recent messages, regardless of how much the client sent', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    // 30 short prior turns (well under the per-message cap) plus the final
    // message -- the client sent more than MAX_HISTORY_MESSAGES (20).
    const longHistory = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }));
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [...longHistory, { role: 'user', content: 'final question' }] },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    const call: any = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(call[1].body as string);
    expect(sentBody.messages.length).toBeLessThanOrEqual(20);
    // The most recent message must survive the trim.
    expect(sentBody.messages[sentBody.messages.length - 1].content).toBe('final question');
  });

  it('caps total history by character budget too, not just message count', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    // 15 messages (under the 20-message count cap) but each near the
    // per-message cap -- well over the 20000-char total history budget.
    const bigHistory = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'y'.repeat(3900) }));
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [...bigHistory, { role: 'user', content: 'final question' }] },
    };
    const res = makeRes();
    await handleAiAssistant(req, res);
    const call: any = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(call[1].body as string);
    const totalChars = sentBody.messages.reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    expect(totalChars).toBeLessThanOrEqual(20000);
    expect(sentBody.messages[sentBody.messages.length - 1].content).toBe('final question');
  });

  it('enforces a global ceiling across all users on top of the per-user cap', async () => {
    mockEnforceRateLimit.mockImplementation(async (_auth: string, key: string) => key !== 'ai_assistant_global');
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('Phase 3A: the global ceiling is now 500/hour, not 2000', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) })));
    await handleAiAssistant(req, res);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith('Bearer tok', 'ai_assistant_global', 500, 3600);
  });
});

// Phase 3A cost-optimization: prompt caching on the static system+tools
// prefix, and a request-local web-search counter that caps the TRUE
// per-HTTP-request total at 3 (previously 3-per-round x 5 rounds = up to
// 15/request, since WEB_SEARCH_TOOL's own max_uses reset every round).
describe('handleAiAssistant: prompt caching', () => {
  function lastRequestBody(fetchSpy: any): any {
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as any;
    return JSON.parse(call[1].body as string);
  }

  it('sends the system prompt as a cache_control-marked block, not a bare string', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());
    const body = lastRequestBody(fetchSpy);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(typeof body.system[0].text).toBe('string');
    expect(body.system[0].text.length).toBeGreaterThan(0);
  });

  it('marks the last tool definition with cache_control (caches the whole static tools array)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());
    const body = lastRequestBody(fetchSpy);
    const lastTool = body.tools[body.tools.length - 1];
    expect(lastTool.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('never attaches cache_control to the dynamic messages/conversation array', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());
    const body = lastRequestBody(fetchSpy);
    expect(JSON.stringify(body.messages)).not.toContain('cache_control');
  });

  it('keeps a valid, cache-marked request structure across multiple tool-calling rounds', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'search_events', input: { query: 'afrobeats' } }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    mockExecuteReadOnlyTool.mockResolvedValueOnce([{ id: 'evt1' }]);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'find events' }] } };
    await handleAiAssistant(req, makeRes());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse((call as any)[1].body as string);
      expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(body.tools[body.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    }
  });
});

describe('handleAiAssistant: web search is capped per HTTP request, not per round', () => {
  function requestBody(fetchSpy: any, callIndex: number): any {
    const call = fetchSpy.mock.calls[callIndex] as any;
    return JSON.parse(call[1].body as string);
  }

  it('offers the full budget (max_uses: 3) on the first round of a fresh request', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'search the web' }] } };
    await handleAiAssistant(req, makeRes());
    const body = requestBody(fetchSpy, 0);
    const searchTool = body.tools.find((t: any) => t.name === 'web_search');
    expect(searchTool.max_uses).toBe(3);
  });

  it('shrinks the offered budget round-to-round as searches are consumed, and drops the tool once exhausted', async () => {
    // Round 1: model uses all 3 searches in one go (server_tool_use reports 3).
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', id: 't1', name: 'search_events', input: {} }],
          usage: { server_tool_use: { web_search_requests: 3 } },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'done' }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    mockExecuteReadOnlyTool.mockResolvedValueOnce([]);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'search a lot' }] } };
    await handleAiAssistant(req, makeRes());

    const round1Body = requestBody(fetchSpy, 0);
    expect(round1Body.tools.find((t: any) => t.name === 'web_search').max_uses).toBe(3);

    // Round 2: budget is exhausted (3 used, cap is 3) -- web_search must be
    // entirely absent from the tools offered, not just max_uses: 0.
    const round2Body = requestBody(fetchSpy, 1);
    expect(round2Body.tools.find((t: any) => t.name === 'web_search')).toBeUndefined();
    // The model must still be able to use its other (non-search) tools --
    // confirmed by the fact VENTS's own search_events tool is still present.
    expect(round2Body.tools.find((t: any) => t.name === 'search_events')).toBeDefined();
  });

  it('a fresh HTTP request always starts with a full, unshared budget, even right after another request exhausted its own', async () => {
    const exhaustedFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'done' }], usage: { server_tool_use: { web_search_requests: 3 } } }),
      });
    vi.stubGlobal('fetch', exhaustedFetch);
    const req1: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'search a lot' }] } };
    await handleAiAssistant(req1, makeRes());
    vi.unstubAllGlobals();

    // Second, independent call to the handler -- simulating a brand new
    // HTTP request (possibly from the SAME user, possibly a different one;
    // the counter is a local variable inside this one function call, so it
    // cannot carry over either way).
    const freshFetch = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }));
    vi.stubGlobal('fetch', freshFetch);
    const req2: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'search again' }] } };
    await handleAiAssistant(req2, makeRes());
    const body2 = requestBody(freshFetch, 0);
    expect(body2.tools.find((t: any) => t.name === 'web_search').max_uses).toBe(3);
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
