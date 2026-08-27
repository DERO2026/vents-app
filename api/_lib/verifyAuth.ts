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

// Fixed-window rate limit via the shared check_rate_limit RPC, called with the
// caller's own (forwarded) token — the RPC is authenticated-callable and keys
// off the string we pass. Returns false when the window is exceeded (the RPC
// raises), which callers turn into HTTP 429.
export async function enforceRateLimit(authHeader: string, key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return true; // fail-open only if misconfigured; endpoints still gate on password
  try {
    const res = await fetch(`${baseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { Authorization: authHeader, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_max_attempts: maxAttempts, p_window_seconds: windowSeconds }),
    });
    return res.ok; // false → limit exceeded (RPC raises)
  } catch {
    return true;
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
