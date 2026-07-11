// Validates a bearer token against InsForge's own session endpoint before an
// endpoint does any real work (spending a paid third-party API call,
// resolving bank details, etc). Checking that an Authorization header is
// merely *present* proves nothing — this actually round-trips to InsForge
// and only succeeds if the token is a currently-valid, live session.

export async function verifyInsforgeSession(authHeader: string | undefined): Promise<{ userId: string } | null> {
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
    return userId ? { userId } : null;
  } catch {
    return null;
  }
}
