// Username login and the failed-login account-status check.
//
// P0 (2026-11-27): the web app (since #125, 26 Nov) calls the 0227 RPCs
// resolve_login_email / get_login_account_status, but 0227 is not applied
// in production. Supabase's API answered every username login with 404
// (PGRST202, "function not found"), which the login screen reported as
// "We couldn't verify your login right now. Please check your connection".
// Email login never used these RPCs and kept working.
//
// Fix: when -- and only when -- the server says the 0227 function does not
// exist, fall back to the pre-0227 functions resolve_username_to_email /
// get_account_status, exactly as the app used them before 26 Nov. They are
// still deployed and callable by anyone until 0228 revokes them, and 0228
// requires 0227 first, so at every point in time one of the two paths
// exists. Once 0227 is applied the fallback never runs. Any other failure
// (network, server error, rate limit) is never treated as "missing".
//
// No account and wrong password still produce the same generic answer in
// every path (no username enumeration through the login screen).

type RpcResult<T = any> = { data: T | null; error: { message?: string; code?: string; details?: string; hint?: string } | null; status?: number };
export type RpcClient = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult> };

/** The server says the function does not exist (PostgREST PGRST202 / HTTP 404 / Postgres 42883). */
export function isMissingRpc(res: RpcResult): boolean {
  const e = res.error;
  if (!e) return false;
  if (e.code === 'PGRST202' || e.code === '42883') return true;
  if (res.status === 404) return true;
  return /could not find the function|function .* does not exist/i.test(e.message || '');
}

/** The request never reached the server (offline, DNS, CORS, dropped connection). */
export function isNetworkFailure(message: string | undefined): boolean {
  return /failed to fetch|load failed|networkerror|network request failed|fetch failed|err_network|timed? ?out/i.test(message || '');
}

/** Error carrying why the username could not be looked up. */
export class LoginLookupError extends Error {
  constructor(public readonly kind: 'network' | 'unavailable', detail: string) {
    super(`LOGIN_LOOKUP_FAILED[${kind}]: ${detail}`);
    this.name = 'LoginLookupError';
  }
}

export const LOGIN_MESSAGES = {
  network: "We couldn't reach the server. Please check your connection and try again.",
  unavailable: 'Logging in with a username is temporarily unavailable. Please try again shortly, or log in with your email address.',
  rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
  invalid: 'Incorrect email or password.',
} as const;

function lookupFailure(res: RpcResult): LoginLookupError {
  const msg = res.error?.message || 'username lookup failed';
  return new LoginLookupError(isNetworkFailure(msg) ? 'network' : 'unavailable', msg);
}

/**
 * Resolves a username to the account's login email. Returns null when there
 * is no such account or (0227 path) the password is wrong: both end as the
 * same generic "Incorrect email or password". Throws LoginLookupError when
 * the lookup itself failed, and Error(LOGIN_MESSAGES.rateLimited) when rate
 * limited.
 */
export async function resolveUsernameToLoginEmail(client: RpcClient, username: string, password: string): Promise<string | null> {
  const p_username = username.trim().toLowerCase();
  const res = await client.rpc('resolve_login_email', { p_username, p_password: password });
  if (res.error && /rate_limited/i.test(res.error.message || '')) throw new Error(LOGIN_MESSAGES.rateLimited);
  if (!res.error) return (res.data as string | null) || null;
  if (!isMissingRpc(res)) throw lookupFailure(res);

  // 0227 not applied on this database yet: the pre-0227 lookup (still deployed).
  const legacy = await client.rpc('resolve_username_to_email', { p_username });
  if (legacy.error) throw lookupFailure(legacy);
  return (legacy.data as string | null) || null;
}

/**
 * After a failed sign-in: is this the owner's suspended or deleted account?
 * Best effort; never throws, returns null when unknown.
 */
export async function getLoginAccountStatus(client: RpcClient, identifier: string, password: string): Promise<{ status: string; banned_until: string | null } | null> {
  const pick = (d: any) => (Array.isArray(d) ? d[0] : d) || null;
  try {
    const res = await client.rpc('get_login_account_status', { p_identifier: identifier, p_password: password });
    if (!res.error) return pick(res.data);
    if (!isMissingRpc(res)) return null;
    // Pre-0227 status check, as the app did before 26 Nov.
    let email = identifier;
    if (!identifier.includes('@')) {
      const r = await client.rpc('resolve_username_to_email', { p_username: identifier.trim().toLowerCase() });
      if (r.error || !r.data) return null;
      email = r.data as string;
    }
    const legacy = await client.rpc('get_account_status', { p_email: email });
    return legacy.error ? null : pick(legacy.data);
  } catch {
    return null;
  }
}
