import { describe, it, expect, vi, beforeEach } from 'vitest';

// Behavioral tests for api/extract-events.ts's `{ mode: 'ai_assistant' }`
// discriminator, added when api/ai-assistant.ts (its own Vercel serverless
// function) was folded into api/extract-events.ts to stay within Vercel
// Hobby's 12-serverless-function-per-deployment cap. These prove:
//   - a `mode: 'ai_assistant'` request routes to the AI handler, and does so
//     BEFORE this file's own extraction-only verifyInsforgeSession call runs
//     (the AI handler gates its own auth independently -- see
//     aiAssistantHandler.behavior.test.ts / api/_lib/aiAssistantHandler.ts).
//   - a normal extract-events request (text or vision) is never routed to
//     the AI handler, including adversarial bodies that try to smuggle a
//     truthy-but-wrong `mode` value or that also set `mode` alongside
//     extraction fields.
//   - GET/OPTIONS behavior is untouched by the discriminator.

const { mockHandleAiAssistant, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockHandleAiAssistant: vi.fn(async (_req: any, res: any) => {
    res.status(200).json({ type: 'message', text: 'ai handled', cards: [] });
  }),
  mockVerifyInsforgeSession: vi.fn(async () => ({ userId: 'u1', email: 'u1@example.com' })),
}));

vi.mock('../../api/_lib/aiAssistantHandler', () => ({
  handleAiAssistant: mockHandleAiAssistant,
}));
vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
}));
vi.mock('../../api/_lib/cors', () => ({
  applyCors: vi.fn(),
}));

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
  mockHandleAiAssistant.mockClear();
  mockVerifyInsforgeSession.mockClear();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('extract-events.ts: mode discriminator routing', () => {
  it('routes an explicit ai_assistant-mode request to handleAiAssistant, before this file\'s own session check', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { mode: 'ai_assistant', messages: [{ role: 'user', content: 'hi' }] } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).toHaveBeenCalledTimes(1);
    expect(mockHandleAiAssistant).toHaveBeenCalledWith(req, res);
    // extract-events.ts's own verifyInsforgeSession call must not run on this path --
    // the AI handler gates its own auth entirely independently.
    expect(mockVerifyInsforgeSession).not.toHaveBeenCalled();
  });

  it('does not route a normal text-extraction request to the AI handler', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'Afrobeats concert Sept 20 Lagos' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
    expect(mockVerifyInsforgeSession).toHaveBeenCalledTimes(1);
  });

  it('does not route a vision (imageBase64) request to the AI handler', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { imageBase64: 'AAAA', mimeType: 'image/jpeg' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
    expect(mockVerifyInsforgeSession).toHaveBeenCalledTimes(1);
  });

  it('adversarial: a truthy but non-exact-string mode value never triggers AI routing', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { mode: true, text: 'x' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
  });

  it('adversarial: an object mode value never triggers AI routing', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { mode: { ai_assistant: true }, text: 'x' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
  });

  it('adversarial: a wrong-case or near-miss mode string never triggers AI routing', async () => {
    for (const mode of ['AI_ASSISTANT', 'Ai_Assistant', 'ai-assistant', 'ai_assistant ', ' ai_assistant']) {
      const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { mode, text: 'x' } };
      const res = makeRes();
      await handler(req, res);
      expect(mockHandleAiAssistant).not.toHaveBeenCalled();
    }
  });

  it('adversarial: mode set alongside extraction fields (text/imageBase64) still routes to the AI handler, never falling through to extraction', async () => {
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { mode: 'ai_assistant', text: 'should be ignored', imageBase64: 'should be ignored', messages: [] },
    };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).toHaveBeenCalledTimes(1);
  });

  it('a missing body does not throw and does not route to the AI handler', async () => {
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' } };
    const res = makeRes();
    await expect(handler(req, res)).resolves.not.toThrow();
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
  });

  it('GET (the ANTHROPIC_API_KEY configured status check) is unaffected by the discriminator', async () => {
    const req: any = { method: 'GET', headers: {}, body: { mode: 'ai_assistant' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ configured: false });
  });

  it('OPTIONS is unaffected by the discriminator', async () => {
    const req: any = { method: 'OPTIONS', headers: {}, body: { mode: 'ai_assistant' } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('an unauthenticated ai_assistant-mode request is still gated by the AI handler\'s own auth (not skipped)', async () => {
    mockHandleAiAssistant.mockImplementationOnce(async (_req: any, res: any) => {
      res.status(401).json({ error: 'Not authenticated' });
    });
    const req: any = { method: 'POST', headers: {}, body: { mode: 'ai_assistant', messages: [] } };
    const res = makeRes();
    await handler(req, res);
    expect(mockHandleAiAssistant).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
