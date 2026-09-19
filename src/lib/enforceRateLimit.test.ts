import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enforceRateLimit } from '../../api/_lib/verifyAuth';

// enforceRateLimit() calls check_rate_limit() directly via the client-
// authenticated REST RPC path. Migration 0026 revoked `authenticated`'s
// EXECUTE on check_rate_limit() (every other caller in the codebase invokes
// it from inside another SECURITY DEFINER function instead) -- so a naive
// "any non-2xx means rate limited" check misread that permission-denied
// response as a real rate-limit hit on every single call. These tests prove
// the fix: only a genuine P0429 response blocks the request.

describe('enforceRateLimit', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-key' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('blocks on a genuine P0429 rate-limit response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ code: 'P0429', message: 'rate_limited' }),
    })));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(false);
  });

  it('blocks on a rate_limited message without the P0429 code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ message: 'rate_limited: too many attempts' }),
    })));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(false);
  });

  it('does NOT classify a permission-denied response as rate-limited', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ code: '42501', message: 'permission denied for function check_rate_limit' }),
    })));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('does NOT classify an unparsable error body as rate-limited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => { throw new Error('not json'); },
    })));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
  });

  it('allows a successful check_rate_limit response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
  });

  it('fails open on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
  });

  it('fails open when Supabase env vars are missing', async () => {
    process.env.VITE_SUPABASE_URL = '';
    process.env.VITE_SUPABASE_ANON_KEY = '';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const allowed = await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    expect(allowed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves the policy: does not hardcode a different max/window than what the caller passes', async () => {
    const fetchSpy = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchSpy);
    await enforceRateLimit('Bearer token', 'ai_assistant:user-1', 20, 3600);
    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({ p_key: 'ai_assistant:user-1', p_max_attempts: 20, p_window_seconds: 3600 });
  });
});
