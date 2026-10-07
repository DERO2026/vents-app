import { describe, it, expect, vi, beforeEach } from 'vitest';

// enforceRateLimit() used to call check_rate_limit() directly via the
// client-authenticated REST RPC path. Migration 0026 revoked
// `authenticated`'s EXECUTE on check_rate_limit() (every other caller in the
// codebase invokes it from inside another SECURITY DEFINER function
// instead) -- confirmed live via information_schema.routine_privileges that
// only project_admin/postgres hold EXECUTE on it. That meant EVERY call
// through the old REST path got a permission-denied response, which the old
// "any non-2xx means rate limited" guard (and even the "inspect the actual
// error" guard that replaced it) could never turn into a genuine P0429 --
// the function's own raise never ran, so every one of the 20/hour AI caps,
// the Paystack verify 30/hour cap, and the wallet-deposit-init 10/hour cap
// silently fell open, unconditionally, in production.
//
// Fix (emergency cost-hardening pass): enforceRateLimit now calls
// check_rate_limit over the trusted project_admin Postgres connection
// (api/_lib/projectAdminDb.ts) instead -- the same connection every other
// project_admin-gated RPC in this codebase already uses. These tests prove
// the fix against that new implementation: a genuine P0429 exception
// blocks, any other failure still fails open (same policy as before, just
// now actually reachable), and the exact key/max/window the caller passed
// reach check_rate_limit unchanged.

const { mockCallProjectAdminRpc } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
}));

vi.mock('../../api/_lib/projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));

describe('enforceRateLimit', () => {
  beforeEach(() => {
    mockCallProjectAdminRpc.mockReset();
  });

  it('blocks on a genuine P0429 rate-limit error', async () => {
    const { enforceRateLimit } = await import('../../api/_lib/verifyAuth');
    mockCallProjectAdminRpc.mockRejectedValue({ code: 'P0429', message: 'rate_limited' });
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(false);
  });

  it('blocks on a rate_limited message without the P0429 code', async () => {
    const { enforceRateLimit } = await import('../../api/_lib/verifyAuth');
    mockCallProjectAdminRpc.mockRejectedValue(new Error('rate_limited: too many attempts'));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(false);
  });

  it('fails open (and logs) on an unexpected, non-rate-limit error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { enforceRateLimit } = await import('../../api/_lib/verifyAuth');
    mockCallProjectAdminRpc.mockRejectedValue(new Error('connection terminated'));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('allows a successful check_rate_limit call', async () => {
    const { enforceRateLimit } = await import('../../api/_lib/verifyAuth');
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
  });

  it('preserves the policy: passes the exact key/max/window the caller gave, unchanged', async () => {
    const { enforceRateLimit } = await import('../../api/_lib/verifyAuth');
    mockCallProjectAdminRpc.mockResolvedValue(undefined);
    await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('check_rate_limit', ['ai_assistant:user-1', 20, 3600]);
  });
});
