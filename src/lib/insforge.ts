import { createClient } from '@insforge/sdk';

export const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY,
});

// Clear any leftover tokens that were previously stored in localStorage.
// Sessions are now restored exclusively via the httpOnly refresh cookie
// that InsForge sets on its own domain — readable only by InsForge's servers,
// never by client-side JS.
if (typeof window !== 'undefined') {
  localStorage.removeItem('vents_auth_session');

  const httpClient = insforge.getHttpClient();

  if (httpClient) {
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
