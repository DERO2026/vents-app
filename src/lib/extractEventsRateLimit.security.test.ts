import { describe, it, expect, vi, beforeEach } from 'vitest';

// Scalability/cost audit finding: api/extract-events.ts's text-extraction
// and vision-crop branches spend a real, billed Anthropic API call per
// request, gated only on having a valid session -- unlike the sibling
// ai_assistant branch in the same file (api/_lib/aiAssistantHandler.ts),
// which has always called enforceRateLimit(20/hour). An authenticated
// client could script unbounded calls to either branch with no backend
// cap, a runaway-cost risk. Fixed by adding the same enforceRateLimit gate,
// keyed per user, before either branch runs.

const { mockVerifyInsforgeSession, mockEnforceRateLimit, mockHandleAiAssistant, mockIsAiDisabled } = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
  mockHandleAiAssistant: vi.fn(),
  // Emergency cost-hardening pass: always allow here so these
  // rate-limit-focused tests keep exercising enforceRateLimit, not the
  // kill switch (that gets its own coverage in
  // aiAssistantKillSwitch.security.test.ts).
  mockIsAiDisabled: vi.fn(async () => false),
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
  mockHandleAiAssistant.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1' });
  mockEnforceRateLimit.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
});

describe('extract-events text-extraction branch is rate-limited', () => {
  it('calls enforceRateLimit, keyed per user, before making any Anthropic call', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: '[]' }] }) });
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'some event text' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith('Bearer tok', 'extract_events:user-1', 20, 3600);
    const rateLimitCallOrder = mockEnforceRateLimit.mock.invocationCallOrder[0];
    const fetchCallOrder = (global.fetch as any).mock.invocationCallOrder[0];
    expect(rateLimitCallOrder).toBeLessThan(fetchCallOrder);
  });

  it('returns 429 and never calls Anthropic when the rate limit is exceeded', async () => {
    mockEnforceRateLimit.mockResolvedValue(false);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'some event text' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('extract-events vision-crop branch is also rate-limited', () => {
  it('returns 429 and never calls Anthropic vision when the rate limit is exceeded', async () => {
    mockEnforceRateLimit.mockResolvedValue(false);
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is gated by the same per-user rate limit key as the text branch', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: '{"focus":{"x":0.5,"y":0.5}}' }] }) });
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { imageBase64: 'ZmFrZQ==', mimeType: 'image/jpeg' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith('Bearer tok', 'extract_events:user-1', 20, 3600);
  });
});

describe('the ai_assistant branch is unaffected by this fix', () => {
  it('still dispatches to handleAiAssistant without going through the extract-events rate limit or session check first', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { mode: 'ai_assistant', messages: [] } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).toHaveBeenCalledWith(req, res);
    expect(mockVerifyInsforgeSession).not.toHaveBeenCalled();
  });
});
