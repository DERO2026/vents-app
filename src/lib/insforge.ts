import { createClient } from '@insforge/sdk';
import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

export const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY,
});

const SESSION_KEY = 'vents_rt';

// On native (Capacitor/Android), the refresh token is persisted through
// @aparajita/capacitor-secure-storage — backed by the Android Keystore
// (EncryptedSharedPreferences), not plain SharedPreferences, so it isn't
// readable even on a rooted device without breaking the Keystore itself.
// On web, there's no native Keychain equivalent; sessionStorage remains
// the least-bad option (cleared when the tab closes, unlike localStorage
// which persists indefinitely and widens the XSS exposure window). Both
// paths are wrapped so every caller gets the same async API regardless of
// platform.
const isNative = Capacitor.isNativePlatform();

export async function readRefreshToken(): Promise<string | null> {
  try {
    if (isNative) return await SecureStorage.getItem(SESSION_KEY);
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export async function saveRefreshToken(token: string): Promise<void> {
  try {
    if (isNative) await SecureStorage.setItem(SESSION_KEY, token);
    else sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    /* ignore — falling back to relying on the SDK's own session handling */
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    if (isNative) await SecureStorage.removeItem(SESSION_KEY);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Returns the current authenticated access token, refreshing if necessary.
 * Safe to call before any storage upload — works after a page refresh.
 */
export async function getAuthToken(): Promise<string> {
  await rehydrated;
  const hc = (insforge as any).getHttpClient?.();

  // 1. Try the SDK's official accessor first
  const direct = (insforge.auth as any).getAccessToken?.();
  if (direct) return direct;

  // 2. Fall back to the HTTP client's in-memory token
  if (hc?.userToken) return hc.userToken as string;

  // 3. Try manual refresh using the stored refresh token (most reliable after page reload)
  const storedRt = await readRefreshToken();
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
        const at = refreshJson.accessToken || refreshJson.access_token;
        if (at) {
          hc.userToken = at;
          const newRt = refreshJson.refreshToken || refreshJson.refresh_token;
          if (newRt) {
            hc.refreshToken = newRt;
            await saveRefreshToken(newRt);
          }
          return at as string;
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
    const after = (insforge.auth as any).getAccessToken?.();
    if (after) return after;
    if (hc?.userToken) return hc.userToken as string;
  } catch { /* fall through */ }

  throw new Error('Session expired. Please sign out and sign back in, then try again.');
}

// Resolves once the previously-saved refresh token (if any) has been
// restored onto the http client — getAuthToken() awaits this before doing
// anything else so it never races the async native storage read.
let rehydrated: Promise<void> = Promise.resolve();

if (typeof window !== 'undefined') {
  localStorage.removeItem('vents_auth_session');

  const httpClient: any = insforge.getHttpClient();

  if (httpClient) {
    // Restore a previously-saved refresh token so getCurrentUser() can
    // rehydrate the session without relying on cross-domain httpOnly cookies
    // (which don't work on http://localhost vs https://insforge.app).
    rehydrated = readRefreshToken().then((stored) => {
      if (stored) httpClient.refreshToken = stored;
    });

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
            await saveRefreshToken(response.refreshToken);
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
