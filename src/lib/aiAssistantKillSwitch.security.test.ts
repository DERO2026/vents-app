import { describe, it, expect, vi, beforeEach } from 'vitest';

// Emergency cost-hardening pass (production billing audit): the master
// Anthropic kill switch (ai_disabled(), 0163_emergency_cost_hardening.sql,
// surfaced via isAiDisabled in api/_lib/verifyAuth.ts) must cover ALL THREE
// Anthropic call sites -- VENTS AI chat (covered directly in
// aiAssistantHandler.behavior.test.ts) and the text-extraction/vision-crop
// branches of api/extract-events.ts, covered here. Both of the latter two
// share one gate (see api/extract-events.ts), so one set of tests proves
// both are actually blocked, not just that a flag exists somewhere.

const { mockVerifyInsforgeSession, mockEnforceRateLimit, mockIsAiDisabled, mockHandleAiAssistant } = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockIsAiDisabled: vi.fn(),
  mockHandleAiAssistant: vi.fn(),
}));

vi.mock('../../api/_lib/verifyAuth.js', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
  isAiDisabled: mockIsAiDisabled,
}));
vi.mock('../../api/_lib/cors.js', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/aiAssistantHandler.js', () => ({ handleAiAssistant: mockHandleAiAssistant }));

import handler from '../../api/extract-events';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

beforeEach(() => {
  mockVerifyInsforgeSession.mockReset();
  mockEnforceRateLimit.mockReset();
  mockIsAiDisabled.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1' });
  mockEnforceRateLimit.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
});

describe('extract-events text-extraction: emergency Anthropic kill switch', () => {
  it('returns 503 and never calls Anthropic when the kill switch is on', async () => {
    mockIsAiDisabled.mockResolvedValue(true);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'some event text' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'AI_UNAVAILABLE' }));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checks the kill switch AFTER rate limiting, so a rate-limited call never even reaches it', async () => {
    mockEnforceRateLimit.mockResolvedValue(false);
    mockIsAiDisabled.mockResolvedValue(false);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'some event text' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockIsAiDisabled).not.toHaveBeenCalled();
  });

  it('proceeds to call Anthropic when the kill switch is off', async () => {
    mockIsAiDisabled.mockResolvedValue(false);
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: '[]' }] }) });
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'some event text' } };
    const res = makeRes();
    await handler(req, res);
    expect(global.fetch).toHaveBeenCalled();
  });
});

describe('extract-events vision-crop: emergency Anthropic kill switch', () => {
  it('returns 503 and never calls Anthropic vision when the kill switch is on', async () => {
    mockIsAiDisabled.mockResolvedValue(true);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the kill switch never leaks internal detail to the client', () => {
  it('the 503 body contains no API key, provider hostname, or raw error text', async () => {
    mockIsAiDisabled.mockResolvedValue(true);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'some event text' } };
    const res = makeRes();
    await handler(req, res);
    const jsonBody = res.json.mock.calls[0][0];
    expect(JSON.stringify(jsonBody)).not.toMatch(/test-key|sk-ant|anthropic\.com/i);
  });
});
