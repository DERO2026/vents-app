// Validates a bearer token against InsForge's own session endpoint before an
// endpoint does any real work (spending a paid third-party API call,
// resolving bank details, etc). Checking that an Authorization header is
// merely *present* proves nothing — this actually round-trips to InsForge
// and only succeeds if the token is a currently-valid, live session.

export async function verifyInsforgeSession(authHeader: string | undefined): Promise<{ userId: string; email: string | null } | null> {
  if (!authHeader) return null;
  const baseUrl = process.env.VITE_INSFORGE_URL;
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/api/auth/sessions/current`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const userId = data?.user?.id;
    return userId ? { userId, email: data?.user?.email ?? null } : null;
  } catch {
    return null;
  }
}

// Server-side re-confirmation of the caller's password for sensitive
// mutations (changing where money is paid out). We deliberately re-verify
// against InsForge's own sign-in endpoint rather than trusting any
// client-side "I entered my password" flag — a fresh sign-in with the
// supplied password is the only thing that proves the human is present.
// Biometric (Face ID / Touch ID) is offered client-side as an accelerator
// that unlocks this same confirmation; the server gate is always the password.
//
// Returns the FRESH access token minted by that sign-in (or null on failure).
// Callers pass this token to the mutation RPC, which requires a recent `iat`
// — so the gate cannot be bypassed by replaying an older session token.
export async function confirmPassword(email: string | null, password: string | undefined): Promise<string | null> {
  if (!email || !password || typeof password !== 'string') return null;
  const baseUrl = process.env.VITE_INSFORGE_URL;
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return typeof data?.accessToken === 'string' ? data.accessToken : null;
  } catch {
    return null;
  }
}

// Fixed-window rate limit via the shared check_rate_limit RPC, called with the
// caller's own (forwarded) token — the RPC is authenticated-callable and keys
// off the string we pass. Returns false when the window is exceeded (the RPC
// raises), which callers turn into HTTP 429.
export async function enforceRateLimit(authHeader: string, key: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) return true; // fail-open only if misconfigured; endpoints still gate on password
  try {
    const res = await fetch(`${baseUrl}/api/database/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { Authorization: authHeader, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_max_attempts: maxAttempts, p_window_seconds: windowSeconds }),
    });
    return res.ok; // false → limit exceeded (RPC raised)
  } catch {
    return true;
  }
}
