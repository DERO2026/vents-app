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
