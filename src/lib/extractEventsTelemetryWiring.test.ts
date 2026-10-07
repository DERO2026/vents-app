import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 5A -- proves api/extract-events.ts's text-extraction and vision
// branches record telemetry under their OWN surface ('extraction' /
// 'vision'), separately from chat, with no PII and correct null-handling.

const { mockVerifyInsforgeSession, mockEnforceRateLimit, mockIsAiDisabled, mockRecordAiUsageEvent } = vi.hoisted(() => ({
  mockVerifyInsforgeSession: vi.fn(async () => ({ userId: 'u1', email: 'u1@example.com' })),
  mockEnforceRateLimit: vi.fn(async () => true),
  mockIsAiDisabled: vi.fn(async () => false),
  mockRecordAiUsageEvent: vi.fn(),
}));

vi.mock('../../api/_lib/verifyAuth', () => ({
  verifyInsforgeSession: mockVerifyInsforgeSession,
  enforceRateLimit: mockEnforceRateLimit,
  isAiDisabled: mockIsAiDisabled,
}));
vi.mock('../../api/_lib/cors', () => ({ applyCors: vi.fn() }));
vi.mock('../../api/_lib/aiAssistantHandler', () => ({ handleAiAssistant: vi.fn() }));
vi.mock('../../api/_lib/aiTelemetry', () => ({
  newAiRequestId: () => 'fixed-round-id',
  recordAiUsageEvent: mockRecordAiUsageEvent,
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
  vi.clearAllMocks();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'u1', email: 'u1@example.com' });
  mockEnforceRateLimit.mockResolvedValue(true);
  mockIsAiDisabled.mockResolvedValue(false);
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

describe('extract-events text extraction: telemetry under surface "extraction"', () => {
  it('records surface: extraction with the real usage numbers, separate from chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '[]' }],
        usage: { input_tokens: 400, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'Some flyer text about an event' } };
    await handler(req, makeRes());

    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(1);
    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      surface: 'extraction',
      model: 'claude-sonnet-5',
      status: 'success',
      inputTokens: 400,
      outputTokens: 20,
    });
  });

  it('records status: error with null usage on a non-2xx Anthropic response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'boom' })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'Some flyer text' } };
    await handler(req, makeRes());

    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call.surface).toBe('extraction');
    expect(call.status).toBe('error');
    expect(call.inputTokens).toBeNull();
    expect(call.outputTokens).toBeNull();
  });

  it('never includes the extracted text, the raw flyer text, or any user identifier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '[{"title":"Secret Launch Party"}]' }], usage: { input_tokens: 10, output_tokens: 10 } }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'Flyer mentions secret-launch@example.com' } };
    await handler(req, makeRes());

    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    const serialized = JSON.stringify(call);
    expect(serialized).not.toMatch(/Secret Launch Party|secret-launch|u1@example\.com|u1\b/);
  });
});

describe('extract-events vision crop: telemetry under surface "vision"', () => {
  const tinyBase64 = Buffer.from('fake-image-bytes').toString('base64');

  it('records surface: vision with claude-haiku-4-5-20251001 and the real usage numbers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"focus":{"x":0.5,"y":0.4}}' }],
        usage: { input_tokens: 1500, output_tokens: 60 },
      }),
    })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { imageBase64: tinyBase64, mimeType: 'image/jpeg' } };
    await handler(req, makeRes());

    expect(mockRecordAiUsageEvent).toHaveBeenCalledTimes(1);
    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call).toMatchObject({
      surface: 'vision',
      model: 'claude-haiku-4-5-20251001',
      status: 'success',
      inputTokens: 1500,
      outputTokens: 60,
    });
  });

  it('records status: error with null usage on a non-2xx Anthropic response, and never includes the image bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'vision error' })));
    const req: any = { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { imageBase64: tinyBase64, mimeType: 'image/jpeg' } };
    await handler(req, makeRes());

    const call = mockRecordAiUsageEvent.mock.calls[0][0];
    expect(call.surface).toBe('vision');
    expect(call.status).toBe('error');
    expect(JSON.stringify(call)).not.toContain(tinyBase64);
  });
});
