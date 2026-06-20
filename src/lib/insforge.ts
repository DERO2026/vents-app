import { createClient } from '@insforge/sdk';

export const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY,
});

const SESSION_KEY = 'vents_rt';

// Persist and restore refresh token so sessions survive page reloads.
// sessionStorage (not localStorage) — cleared when the tab is closed.
export function saveRefreshToken(token: string) {
  try { sessionStorage.setItem(SESSION_KEY, token); } catch { /* ignore */ }
}

export function clearRefreshToken() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/**
 * Returns the current authenticated access token, refreshing if necessary.
 * Safe to call before any storage upload — works after a page refresh.
 */
export async function getAuthToken(): Promise<string> {
  // 1. Try the SDK's official accessor first
  const direct = insforge.auth.getAccessToken?.();
  if (direct) return direct;

  // 2. Fall back to the HTTP client's in-memory token
  const hc = (insforge as any).getHttpClient?.();
  if (hc?.userToken) return hc.userToken as string;

  // 3. Try manual refresh using the stored refresh token (most reliable after page reload)
  const storedRt = sessionStorage.getItem(SESSION_KEY);
  if (storedRt && hc) {
    try {
      const baseUrl = hc.baseUrl || import.meta.env.VITE_INSFORGE_URL;
      const refreshRes = await fetch(`${baseUrl}/api/auth/refresh?client_type=mobile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: storedRt, refresh_token: storedRt }),
      });
      if (refreshRes.ok) {
        const refreshJson = await refreshRes.json();
        if (refreshJson.accessToken) {
          hc.userToken = refreshJson.accessToken;
          if (refreshJson.refreshToken) {
            hc.refreshToken = refreshJson.refreshToken;
            sessionStorage.setItem(SESSION_KEY, refreshJson.refreshToken);
          }
          return refreshJson.accessToken as string;
        }
      }
    } catch { /* fall through */ }
  }

  // 4. Attempt a silent refresh via the SDK (uses httpOnly cookie on production)
  try {
    const { data } = await insforge.auth.refreshSession?.() ?? { data: null };
    const t = (data as any)?.accessToken || (data as any)?.access_token || (data as any)?.session?.accessToken;
    if (t) {
      if (hc) hc.userToken = t;
      return t as string;
    }
    const after = insforge.auth.getAccessToken?.();
    if (after) return after;
    if (hc?.userToken) return hc.userToken as string;
  } catch { /* fall through */ }

  throw new Error('Session expired. Please sign out and sign back in, then try again.');
}

if (typeof window !== 'undefined') {
  localStorage.removeItem('vents_auth_session');

  const httpClient = insforge.getHttpClient();

  if (httpClient) {
    // Restore a previously-saved refresh token so getCurrentUser() can
    // rehydrate the session without relying on cross-domain httpOnly cookies
    // (which don't work on http://localhost vs https://insforge.app).
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) httpClient.refreshToken = stored;

    // Monkey-patch refreshAccessToken to work around a refreshToken vs
    // refresh_token casing inconsistency in the SDK's refresh request body.
    httpClient.refreshAccessToken = async function () {
      if (this.isRefreshing) {
        return this.refreshPromise;
      }
      this.isRefreshing = true;
      this.refreshPromise = (async () => {
        try {
          const match = document.cookie.split(';').find((c: string) =>
            c.trim().startsWith('insforge_csrf_token=')
          );
          const csrfToken = match ? match.split('=')[1] || null : null;
          const body = this.refreshToken
            ? { refreshToken: this.refreshToken, refresh_token: this.refreshToken }
            : undefined;
          const response = await this.handleRequest(
            'POST',
            this.refreshToken ? '/api/auth/refresh?client_type=mobile' : '/api/auth/refresh',
            {
              body,
              headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
              credentials: 'include',
            }
          );
          // Persist the rotated refresh token if the SDK returns one
          if (response?.refreshToken) {
            httpClient.refreshToken = response.refreshToken;
            saveRefreshToken(response.refreshToken);
          }
          return response;
        } finally {
          this.isRefreshing = false;
          this.refreshPromise = null;
        }
      })();
      return this.refreshPromise;
    };
  }
}
