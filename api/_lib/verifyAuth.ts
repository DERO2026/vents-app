// Validates a bearer token against Supabase's own auth endpoint before an
// endpoint does any real work (spending a paid third-party API call,
// resolving bank details, etc). Checking that an Authorization header is
// merely *present* proves nothing — this actually round-trips to Supabase
// and only succeeds if the token is a currently-valid, live session.
//
// Function names kept as-is (verifyInsforgeSession, etc.) rather than
// renamed to avoid touching every caller's import line for a pure rename —
// the 7 call sites (api/extract-events.ts, api/notify/status-email.ts,
// api/promotions/activate.ts, api/push/send.ts, api/wallet/banks.ts,
// api/wallet/resolve-account.ts, api/wallet/save-bank.ts) only care about
// behavior, not the name. Worth a follow-up rename pass for clarity.

export async function verifyInsforgeSession(authHeader: string | undefined): Promise<{ userId: string; email: string | null } | null> {
  if (!authHeader) return null;
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return null;
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const res = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.id ? { userId: data.id as string, email: (data.email as string) ?? null } : null;
  } catch {
    return null;
  }
}

// Server-side re-confirmation of the caller's password for sensitive
// mutations (changing where money is paid out). We deliberately re-verify
// against Supabase's own password-grant token endpoint rather than trusting
// any client-side "I entered my password" flag — a fresh sign-in with the
// supplied password is the only thing that proves the human is present.
// Biometric (Face ID / Touch ID) is offered client-side as an accelerator
// that unlocks this same confirmation; the server gate is always the password.
//
// Returns the FRESH access token minted by that sign-in (or null on failure).
// Callers pass this token to the mutation RPC, which requires a recent `iat`
// — so the gate cannot be bypassed by replaying an older session token.
export async function confirmPassword(email: string | null, password: string | undefined): Promise<string | null> {
  if (!email || !password || typeof password !== 'string') return null;
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return null;
  try {
    const res = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return typeof data?.access_token === 'string' ? data.access_token : null;
  } catch {
    return null;
  }
}

// Fixed-window rate limit via the shared check_rate_limit RPC.
//
// FIX (emergency cost-hardening pass, following the production billing
// audit): this used to call check_rate_limit directly over the public REST
// RPC endpoint, authenticated as the CALLER's own session (role
// `authenticated`). Migration 0026 revoked `authenticated`'s EXECUTE grant
// on check_rate_limit() entirely (confirmed live via
// information_schema.routine_privileges -- only project_admin/postgres hold
// it) -- so every one of those calls was rejected at the permission-check
// stage, BEFORE check_rate_limit's body (and its P0429 raise) ever ran.
// That made every single call land in this function's own "non-rate-limit
// failure -> fail open" branch, unconditionally, for every endpoint that
// uses this helper -- meaning the extract-events/ai_assistant 20/hour caps,
// the Paystack verify 30/hour cap, and the wallet-deposit-init 10/hour cap
// were ALL silently non-functional in production. Confirmed live: a direct
// REST call to rpc/check_rate_limit as `authenticated` returns a permission
// error, never P0429, regardless of how many times it's called.
//
// Fix: call check_rate_limit over the trusted project_admin Postgres
// connection (api/_lib/projectAdminDb.ts) instead -- the same pattern every
// other project_admin-gated RPC in this codebase already uses (e.g.
// api/_lib/pushDelivery.ts). This requires no grant change (check_rate_limit
// stays unreachable by anon/authenticated directly, preserving 0026's own
// fix), and makes the limit actually enforce: a genuine rate_limited
// response (SQLSTATE P0429) blocks the request; any other failure (network,
// missing env var, unexpected error) still fails open, same as before, so
// an infra hiccup degrades to "unlimited" rather than "every request
// blocked" -- appropriate for a soft per-user throttle (contrast
// isAiDisabled below, which fails CLOSED by design for the same reason a
// kill switch must never silently stay "on").
export async function enforceRateLimit(_authHeader: string, key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  try {
    const { callProjectAdminRpc } = await import('./projectAdminDb.js');
    await callProjectAdminRpc('check_rate_limit', [key, maxAttempts, windowSeconds]);
    return true;
  } catch (err: any) {
    const isRateLimited = err?.code === 'P0429' || /rate_limited/i.test(err?.message || '');
    if (!isRateLimited) {
      console.error('check_rate_limit failed for a non-rate-limit reason:', err?.message || err);
    }
    return !isRateLimited;
  }
}

// Emergency Anthropic kill switch, checked before every one of the three
// Anthropic call sites in api/extract-events.ts / api/_lib/aiAssistantHandler.ts.
// Deliberately the OPPOSITE fail behavior of enforceRateLimit above:
// enforceRateLimit fails OPEN on a network/config error (availability over
// strictness, appropriate for a soft per-user throttle) -- this fails
// CLOSED (AI treated as disabled) on ANY failure to reach or parse the
// check, matching the fail-closed ai_disabled() DB helper it calls
// (0163_emergency_cost_hardening.sql; same COALESCE-to-true pattern as the
// existing purchases_disabled()/payouts_disabled() switches, 0124). A
// misconfigured env var or a transient Supabase outage must stop Anthropic
// spend, never silently allow it -- the one case this function is for.
export async function isAiDisabled(authHeader: string): Promise<boolean> {
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return true; // fail closed: can't check -> treat as disabled
  try {
    const res = await fetch(`${baseUrl}/rest/v1/rpc/ai_disabled`, {
      method: 'POST',
      headers: { Authorization: authHeader, apikey: anonKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return true; // fail closed on any non-2xx (RPC error, auth error, etc)
    const value = await res.json().catch(() => true);
    return value !== false; // anything other than an explicit `false` is treated as disabled
  } catch {
    return true; // fail closed on network error
  }
}

// Wallet bank-account mutation rate limiting. Calls check_wallet_mutation_
// rate_limit (migration 0030), a SECURITY DEFINER wrapper, instead of
// check_rate_limit() directly the way enforceRateLimit() above does --
// migration 0026 revoked `authenticated`'s EXECUTE on check_rate_limit()
// (a real fix for an anon/authenticated Data API exposure on the
// rate_limits table), which broke this endpoint's direct call to it: every
// attempt got a permission-denied response that got misread as "rate
// limited" purely because it wasn't a 2xx. This version inspects the
// actual error instead of assuming any non-2xx means the limit was hit, so
// a genuine rate_limited response (ERRCODE P0429) still blocks the
// request, while any other failure (permissions, network, etc.) fails
// open and gets logged — the same fail-open-on-non-rate-limit-errors
// principle AuthScreen.tsx's checkAuthRateLimit already applies to
// login/signup.
export async function enforceWalletRateLimit(authHeader: string, userId: string): Promise<boolean> {
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return true; // fail-open only if misconfigured; endpoint still gates on password
  try {
    const res = await fetch(`${baseUrl}/rest/v1/rpc/check_wallet_mutation_rate_limit`, {
      method: 'POST',
      headers: { Authorization: authHeader, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => null);
    const isRateLimited = body?.code === 'P0429' || /rate_limited/i.test(body?.message || '');
    if (!isRateLimited) {
      console.error('check_wallet_mutation_rate_limit failed for a non-rate-limit reason:', body);
    }
    return !isRateLimited;
  } catch {
    return true;
  }
}
