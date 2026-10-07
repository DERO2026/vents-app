import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for api/_lib/aiEntitlement.ts -- the thin TypeScript layer
// between aiAssistantHandler.ts and the Phase 4 entitlement/usage RPCs
// (supabase/migrations/0165_ai_subscription_foundation.sql). Mocks
// callProjectAdminRpc and the ai_entitlement_enforced REST call directly --
// no real Postgres connection, no real HTTP call, no real Anthropic
// request anywhere in this file.

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({ mockCallProjectAdminRpc: vi.fn() }));
vi.mock('../../api/_lib/projectAdminDb', () => ({ callProjectAdminRpc: mockCallProjectAdminRpc }));

import { isAiEntitlementEnforced, checkAndReserveAiUsage, startAiTrial, AiEntitlementError } from '../../api/_lib/aiEntitlement';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.VITE_SUPABASE_ANON_KEY;
});

describe('isAiEntitlementEnforced', () => {
  it('fails OPEN (false) when env is not configured -- never throws, never blocks AI chat on a config gap', async () => {
    const result = await isAiEntitlementEnforced('Bearer tok');
    expect(result).toBe(false);
  });

  it('fails OPEN on a network error reaching the RPC', async () => {
    process.env.VITE_SUPABASE_URL = 'https://x.supabase.co';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await isAiEntitlementEnforced('Bearer tok');
    expect(result).toBe(false);
  });

  it('fails OPEN on a non-2xx response', async () => {
    process.env.VITE_SUPABASE_URL = 'https://x.supabase.co';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const result = await isAiEntitlementEnforced('Bearer tok');
    expect(result).toBe(false);
  });

  it('returns true only when the RPC explicitly returns true', async () => {
    process.env.VITE_SUPABASE_URL = 'https://x.supabase.co';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => true }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await isAiEntitlementEnforced('Bearer tok');
    expect(result).toBe(true);
    const call: any = fetchSpy.mock.calls[0];
    expect(call[0]).toMatch(/\/rest\/v1\/rpc\/ai_entitlement_enforced$/);
  });

  it('returns false for any non-true value (e.g. null row, false, missing)', async () => {
    process.env.VITE_SUPABASE_URL = 'https://x.supabase.co';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => false })));
    expect(await isAiEntitlementEnforced('Bearer tok')).toBe(false);
  });
});

describe('checkAndReserveAiUsage', () => {
  it('calls the project_admin RPC with exactly [userId, surface] -- never a client-suppliable identity', async () => {
    mockCallProjectAdminRpc.mockResolvedValueOnce({ allowed: true, plan_id: 'ai', status: 'active', used_units: 1, included_units: 50, hard_ceiling: 75, over_included: false });
    const result = await checkAndReserveAiUsage('user-123', 'chat');
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_and_reserve_ai_usage', ['user-123', 'chat']);
    expect(result.allowed).toBe(true);
  });

  it('maps a no_entitlement DB error to AiEntitlementError with that code', async () => {
    mockCallProjectAdminRpc.mockRejectedValueOnce(new Error('no_entitlement'));
    await expect(checkAndReserveAiUsage('user-123', 'chat')).rejects.toSatisfy(
      (e: any) => e instanceof AiEntitlementError && e.code === 'no_entitlement'
    );
  });

  it('maps an entitlement_expired DB error to AiEntitlementError with that code', async () => {
    mockCallProjectAdminRpc.mockRejectedValueOnce(new Error('entitlement_expired'));
    await expect(checkAndReserveAiUsage('user-123', 'chat')).rejects.toSatisfy(
      (e: any) => e instanceof AiEntitlementError && e.code === 'entitlement_expired'
    );
  });

  it('maps a usage_ceiling_exceeded DB error to AiEntitlementError with that code', async () => {
    const err: any = new Error('usage_ceiling_exceeded');
    mockCallProjectAdminRpc.mockRejectedValueOnce(err);
    await expect(checkAndReserveAiUsage('user-123', 'chat')).rejects.toSatisfy(
      (e: any) => e instanceof AiEntitlementError && e.code === 'usage_ceiling_exceeded'
    );
  });

  it('re-throws an unrecognized error as-is (infra failure, not a legitimate denial)', async () => {
    mockCallProjectAdminRpc.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(checkAndReserveAiUsage('user-123', 'chat')).rejects.toThrow('ECONNRESET');
  });

  it('keeps chat/extraction/vision as fully distinct surface arguments to the RPC', async () => {
    mockCallProjectAdminRpc.mockResolvedValue({ allowed: true });
    await checkAndReserveAiUsage('user-123', 'chat');
    await checkAndReserveAiUsage('user-123', 'extraction');
    await checkAndReserveAiUsage('user-123', 'vision');
    expect(mockCallProjectAdminRpc).toHaveBeenNthCalledWith(1, 'check_and_reserve_ai_usage', ['user-123', 'chat']);
    expect(mockCallProjectAdminRpc).toHaveBeenNthCalledWith(2, 'check_and_reserve_ai_usage', ['user-123', 'extraction']);
    expect(mockCallProjectAdminRpc).toHaveBeenNthCalledWith(3, 'check_and_reserve_ai_usage', ['user-123', 'vision']);
  });
});

describe('startAiTrial', () => {
  it('passes only the userId -- no client-suppliable unit count or plan', async () => {
    mockCallProjectAdminRpc.mockResolvedValueOnce({ plan_id: 'trial', status: 'trialing', included_units: 15, hard_ceiling: 15 });
    const result = await startAiTrial('user-123');
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('start_ai_trial', ['user-123']);
    expect(result.plan_id).toBe('trial');
  });

  it('maps trial_already_used to a stable AiEntitlementError code', async () => {
    mockCallProjectAdminRpc.mockRejectedValueOnce(new Error('trial_already_used'));
    await expect(startAiTrial('user-123')).rejects.toSatisfy(
      (e: any) => e instanceof AiEntitlementError && e.code === 'trial_already_used'
    );
  });
});
