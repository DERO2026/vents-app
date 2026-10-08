import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Behavioral tests for the plan_messages persistence added in Batch 3 --
// see persistPlanTurn in aiAssistantHandler.ts. Uses the same mocking
// approach as src/lib/aiAssistantHandler.behavior.test.ts, but with a
// fuller fake Supabase client (supporting plan_messages.select/insert)
// since that's what this feature actually exercises.

const {
  mockVerifyInsforgeSession,
  mockEnforceRateLimit,
  mockIsAiDisabled,
  mockExecutePlanTool,
  mockBuildUserSupabaseClient,
  state,
} = vi.hoisted(() => {
  const state = { planMessagesRows: [] as { role: string; content: string }[], insertedRows: [] as any[] };

  function makeChain(result: { data: any; error: any }) {
    const chain: any = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'insert']) chain[m] = () => chain;
    chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
    return chain;
  }

  function makeFakeClient() {
    return {
      from: (table: string) => {
        if (table !== 'plan_messages') return makeChain({ data: null, error: null });
        const chain: any = makeChain({ data: state.planMessagesRows.slice(-1), error: null });
        chain.insert = (rows: any[]) => {
          state.insertedRows.push(...rows);
          state.planMessagesRows.push(...rows.map((r: any) => ({ role: r.role, content: r.content })));
          return Promise.resolve({ data: rows, error: null });
        };
        return chain;
      },
    };
  }

  return {
    mockVerifyInsforgeSession: vi.fn(),
    mockEnforceRateLimit: vi.fn(),
    mockIsAiDisabled: vi.fn(async () => false),
    mockExecutePlanTool: vi.fn(),
    mockBuildUserSupabaseClient: vi.fn(() => makeFakeClient()),
    state,
  };
});

vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
  isAiDisabled: mockIsAiDisabled,
}));
vi.mock('../../api/_lib/cors', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/aiBeta', () => ({ isAiBetaUser: vi.fn(async () => true) }));
vi.mock('../../api/_lib/aiConfirmation', () => ({
  createConfirmationToken: vi.fn(() => 'signed-token'),
  verifyConfirmationToken: vi.fn(),
}));
vi.mock('../../api/_lib/aiTools', () => ({
  ALL_TOOLS: [{ name: 'get_plan' }],
  READ_ONLY_TOOL_NAMES: new Set([]),
  PROPOSAL_TOOL_NAMES: new Set([]),
  PLAN_TOOL_NAMES: new Set(['get_plan', 'create_plan_draft', 'confirm_brief']),
  WEB_SEARCH_TOOL: { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
  WEB_SEARCH_TOOL_NAME: 'web_search',
  buildUserSupabaseClient: mockBuildUserSupabaseClient,
  executeReadOnlyTool: vi.fn(),
  executePlanTool: mockExecutePlanTool,
  buildProposal: vi.fn(),
  executeStartTicketTransfer: vi.fn(),
  executeRequestTicketRefund: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  state.planMessagesRows = [];
  state.insertedRows = [];
  mockVerifyInsforgeSession.mockResolvedValue(SESSION);
  mockEnforceRateLimit.mockResolvedValue(true);
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

function stubAnthropicToolThenText(toolBlock: any, finalText: string) {
  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({ content: [toolBlock] }) };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: finalText }] }) };
  }));
}

describe('plan_messages persistence', () => {
  it('persists the user turn and the assistant reply when exactly one plan was touched (plan_id from the tool result)', async () => {
    stubAnthropicToolThenText(
      { type: 'tool_use', id: 'tu1', name: 'get_plan', input: { plan_id: 'plan-1' } },
      'Your wedding plan has 650,000 allocated to decoration.'
    );
    mockExecutePlanTool.mockResolvedValueOnce({ plan_id: 'plan-1', categories: [] });

    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [{ role: 'user', content: 'how much is allocated to decoration?' }] },
    };
    await handleAiAssistant(req, makeRes());

    expect(state.insertedRows).toHaveLength(2);
    expect(state.insertedRows[0]).toMatchObject({ plan_id: 'plan-1', role: 'user', content: 'how much is allocated to decoration?' });
    expect(state.insertedRows[1]).toMatchObject({ plan_id: 'plan-1', role: 'assistant', content: 'Your wedding plan has 650,000 allocated to decoration.' });
  });

  it('falls back to the plan_id from the tool INPUT when the result does not echo one', async () => {
    stubAnthropicToolThenText(
      { type: 'tool_use', id: 'tu1', name: 'confirm_brief', input: { plan_id: 'plan-2' } },
      'Brief confirmed.'
    );
    mockExecutePlanTool.mockResolvedValueOnce({ id: 'plan-2', status: 'active' }); // no plan_id key

    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [{ role: 'user', content: 'that brief is good, confirm it' }] },
    };
    await handleAiAssistant(req, makeRes());

    expect(state.insertedRows.every((r) => r.plan_id === 'plan-2')).toBe(true);
  });

  it('does not persist anything when no plan tool was touched this turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hi there!' }] }) })));

    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'hi' }] } };
    await handleAiAssistant(req, makeRes());

    expect(state.insertedRows).toHaveLength(0);
  });

  it('does not persist when a plan tool call errors -- an unsuccessful call never contributes a plan_id', async () => {
    stubAnthropicToolThenText(
      { type: 'tool_use', id: 'tu1', name: 'get_plan', input: { plan_id: 'not-mine' } },
      "I couldn't find that plan."
    );
    mockExecutePlanTool.mockRejectedValueOnce(new Error('Plan not found'));

    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'show my plan' }] } };
    await handleAiAssistant(req, makeRes());

    expect(state.insertedRows).toHaveLength(0);
  });

  it('de-duplicates a retried identical user turn against the most recently stored row', async () => {
    state.planMessagesRows = [{ role: 'user', content: 'how much for photography?' }];

    stubAnthropicToolThenText(
      { type: 'tool_use', id: 'tu1', name: 'get_plan', input: { plan_id: 'plan-3' } },
      'Photography has 250,000 allocated.'
    );
    mockExecutePlanTool.mockResolvedValueOnce({ plan_id: 'plan-3' });

    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { messages: [{ role: 'user', content: 'how much for photography?' }] },
    };
    await handleAiAssistant(req, makeRes());

    // The user row is skipped (identical to the already-stored last row);
    // only the new assistant reply is inserted.
    expect(state.insertedRows).toHaveLength(1);
    expect(state.insertedRows[0]).toMatchObject({ role: 'assistant' });
  });

  it('a plan_messages insert failure is swallowed -- the AI response still succeeds', async () => {
    stubAnthropicToolThenText(
      { type: 'tool_use', id: 'tu1', name: 'get_plan', input: { plan_id: 'plan-4' } },
      'Here is your plan.'
    );
    mockExecutePlanTool.mockResolvedValueOnce({ plan_id: 'plan-4' });
    mockBuildUserSupabaseClient.mockReturnValueOnce({
      from: vi.fn(() => {
        throw new Error('db unavailable');
      }),
    });

    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { messages: [{ role: 'user', content: 'show my plan' }] } };
    const res = makeRes();
    await handleAiAssistant(req, res);

    const jsonBody = res.json.mock.calls[0][0];
    expect(jsonBody.type).toBe('message');
    expect(jsonBody.text).toBe('Here is your plan.');
  });
});
