import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({ mockCallProjectAdminRpc: vi.fn() }));
vi.mock('../../api/_lib/projectAdminDb', () => ({ callProjectAdminRpc: mockCallProjectAdminRpc }));

import { recordAiUsageEvent, newAiRequestId } from '../../api/_lib/aiTelemetry';

beforeEach(() => {
  vi.clearAllMocks();
  mockCallProjectAdminRpc.mockResolvedValue(undefined);
});

describe('newAiRequestId', () => {
  it('returns a fresh, random-looking string each call -- never derived from anything user-identifying', () => {
    const a = newAiRequestId();
    const b = newAiRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('recordAiUsageEvent', () => {
  it('calls record_ai_usage_event with exactly the 11 positional args the migration function expects, in order', async () => {
    await recordAiUsageEvent({
      surface: 'chat',
      model: 'claude-sonnet-5',
      roundId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      roundIndex: 0,
      status: 'success',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 8300,
      webSearchRequests: 1,
    });

    expect(mockCallProjectAdminRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockCallProjectAdminRpc.mock.calls[0];
    expect(fnName).toBe('record_ai_usage_event');
    expect(args).toEqual([
      'chat', 'claude-sonnet-5', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 0, 'success',
      100, 50, 0, 8300, 1,
      expect.any(Number), // the calculated cost estimate
    ]);
  });

  it('never includes a userId, email, username, or any field beyond the declared shape -- no PII can leak through', async () => {
    await recordAiUsageEvent({
      surface: 'chat', model: 'claude-sonnet-5', roundId: 'id-1', roundIndex: 0, status: 'success',
      inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, webSearchRequests: null,
    });
    const [, args] = mockCallProjectAdminRpc.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toMatch(/user|email|@|session|token/i);
  });

  it('passes through NULL (not 0, not a guess) for every usage field Anthropic did not report', async () => {
    await recordAiUsageEvent({
      surface: 'extraction', model: 'claude-sonnet-5', roundId: 'id-2', roundIndex: 0, status: 'error',
      inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, webSearchRequests: null,
    });
    const [, args] = mockCallProjectAdminRpc.mock.calls[0];
    // surface, model, roundId, roundIndex, status, then 5 usage fields + estimate.
    expect(args.slice(5, 10)).toEqual([null, null, null, null, null]);
    // No usage -> no cost can be estimated -> the estimate itself must also be null.
    expect(args[10]).toBeNull();
  });

  it('computes a non-null cost estimate when input/output tokens are present', async () => {
    await recordAiUsageEvent({
      surface: 'vision', model: 'claude-haiku-4-5-20251001', roundId: 'id-3', roundIndex: 0, status: 'success',
      inputTokens: 1500, outputTokens: 80, cacheCreationInputTokens: null, cacheReadInputTokens: null, webSearchRequests: null,
    });
    const [, args] = mockCallProjectAdminRpc.mock.calls[0];
    expect(typeof args[10]).toBe('number');
    expect(args[10]).toBeGreaterThan(0);
  });

  it('never throws -- a telemetry failure is swallowed and never propagates to the caller', async () => {
    mockCallProjectAdminRpc.mockRejectedValueOnce(new Error('PROJECT_ADMIN_DATABASE_URL not set'));
    await expect(recordAiUsageEvent({
      surface: 'chat', model: 'claude-sonnet-5', roundId: 'id-4', roundIndex: 0, status: 'success',
      inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: null, cacheReadInputTokens: null, webSearchRequests: null,
    })).resolves.toBeUndefined();
  });
});
