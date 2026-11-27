import { describe, it, expect, vi } from 'vitest';
import { resolveUsernameToLoginEmail, getLoginAccountStatus, isMissingRpc, LoginLookupError, LOGIN_MESSAGES } from './loginLookup';

// P0 2026-11-27: production answered resolve_login_email with 404
// (PGRST202, the 0227 function is not deployed) and every username login
// failed. These tests pin the fallback: the pre-0227 lookup is used ONLY when
// the server says the 0227 function does not exist; every other failure is
// reported as what it is and never falls back.

const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.resolve_login_email(p_password, p_username) in the schema cache' }, status: 404 };
const ok = (data: any) => ({ data, error: null, status: 200 });
function client(answers: Record<string, any>) {
  const rpc = vi.fn(async (fn: string) => {
    const a = answers[fn];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unexpected rpc ${fn}`);
    return a;
  });
  return { rpc };
}

describe('resolveUsernameToLoginEmail', () => {
  it('0227 deployed: uses resolve_login_email only, with the lower-cased username and the password', async () => {
    const c = client({ resolve_login_email: ok('ada@example.com') });
    expect(await resolveUsernameToLoginEmail(c, '  Ada ', 'pw')).toBe('ada@example.com');
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith('resolve_login_email', { p_username: 'ada', p_password: 'pw' });
  });

  it('0227 deployed, wrong password or no such user: null (same generic answer), no fallback', async () => {
    const c = client({ resolve_login_email: ok(null) });
    expect(await resolveUsernameToLoginEmail(c, 'ada', 'bad')).toBeNull();
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });

  it('THE PRODUCTION BUG: 0227 missing (404 PGRST202) -> the pre-0227 lookup resolves the email', async () => {
    const c = client({ resolve_login_email: missing, resolve_username_to_email: ok('ada@example.com') });
    expect(await resolveUsernameToLoginEmail(c, 'Ada', 'pw')).toBe('ada@example.com');
    expect(c.rpc).toHaveBeenLastCalledWith('resolve_username_to_email', { p_username: 'ada' });
  });

  it('0227 missing, unknown username: null (generic "incorrect"), never "no account found"', async () => {
    const c = client({ resolve_login_email: missing, resolve_username_to_email: ok(null) });
    expect(await resolveUsernameToLoginEmail(c, 'nobody', 'pw')).toBeNull();
  });

  it('also recognises a missing function by HTTP 404 or the Postgres message', () => {
    expect(isMissingRpc({ data: null, error: { message: 'x' }, status: 404 })).toBe(true);
    expect(isMissingRpc({ data: null, error: { message: 'function public.resolve_login_email(text, text) does not exist', code: '42883' } })).toBe(true);
    expect(isMissingRpc({ data: null, error: { message: 'internal error', code: 'XX000' }, status: 500 })).toBe(false);
    expect(isMissingRpc({ data: 'x', error: null, status: 200 })).toBe(false);
  });

  it('a server error that is NOT "missing" never falls back; it is reported as unavailable', async () => {
    const c = client({ resolve_login_email: { data: null, error: { code: 'XX000', message: 'internal error' }, status: 500 } });
    const err = await resolveUsernameToLoginEmail(c, 'ada', 'pw').catch((e) => e);
    expect(err).toBeInstanceOf(LoginLookupError);
    expect(err.kind).toBe('unavailable');
    expect(err.message).toMatch(/^LOGIN_LOOKUP_FAILED\[unavailable\]/);
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });

  it('a network failure never falls back; it is reported as a network problem', async () => {
    const c = client({ resolve_login_email: { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 } });
    const err = await resolveUsernameToLoginEmail(c, 'ada', 'pw').catch((e) => e);
    expect(err.kind).toBe('network');
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });

  it('rate limited: the rate-limit message, no fallback', async () => {
    const c = client({ resolve_login_email: { data: null, error: { message: 'rate_limited' }, status: 400 } });
    await expect(resolveUsernameToLoginEmail(c, 'ada', 'pw')).rejects.toThrow(LOGIN_MESSAGES.rateLimited);
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });

  it('0227 missing AND the old lookup failing (e.g. after a revoke): a lookup failure, never a wrong-password', async () => {
    const c = client({ resolve_login_email: missing, resolve_username_to_email: { data: null, error: { code: '42501', message: 'permission denied for function resolve_username_to_email' }, status: 401 } });
    const err = await resolveUsernameToLoginEmail(c, 'ada', 'pw').catch((e) => e);
    expect(err).toBeInstanceOf(LoginLookupError);
    expect(err.kind).toBe('unavailable');
  });

  it('messages never blame the password for a lookup failure', () => {
    expect(LOGIN_MESSAGES.network).not.toMatch(/incorrect|wrong/i);
    expect(LOGIN_MESSAGES.unavailable).not.toMatch(/incorrect|wrong/i);
    expect(LOGIN_MESSAGES.unavailable).toMatch(/email address/);
  });
});

describe('getLoginAccountStatus (after a failed sign-in)', () => {
  it('0227 deployed: one call with the identifier and the password', async () => {
    const c = client({ get_login_account_status: ok([{ status: 'suspended', banned_until: null }]) });
    expect(await getLoginAccountStatus(c, 'ada', 'pw')).toEqual({ status: 'suspended', banned_until: null });
    expect(c.rpc).toHaveBeenCalledWith('get_login_account_status', { p_identifier: 'ada', p_password: 'pw' });
  });

  it('0227 missing, email identifier: the pre-0227 status check by email', async () => {
    const c = client({ get_login_account_status: missing, get_account_status: ok([{ status: 'deleted', banned_until: null }]) });
    expect(await getLoginAccountStatus(c, 'ada@example.com', 'pw')).toEqual({ status: 'deleted', banned_until: null });
    expect(c.rpc).toHaveBeenLastCalledWith('get_account_status', { p_email: 'ada@example.com' });
  });

  it('0227 missing, username identifier: resolves first, then checks', async () => {
    const c = client({ get_login_account_status: missing, resolve_username_to_email: ok('ada@example.com'), get_account_status: ok([{ status: 'active', banned_until: null }]) });
    expect((await getLoginAccountStatus(c, 'Ada', 'pw'))?.status).toBe('active');
  });

  it('any other failure: null, and never throws', async () => {
    expect(await getLoginAccountStatus(client({ get_login_account_status: { data: null, error: { message: 'boom' }, status: 500 } }), 'ada', 'pw')).toBeNull();
    expect(await getLoginAccountStatus(client({ get_login_account_status: new Error('network') }), 'ada', 'pw')).toBeNull();
  });
});
