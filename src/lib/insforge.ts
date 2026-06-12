import { createClient } from '@insforge/sdk';

export const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY,
});

// Setup token storage sync for browser/localhost persistence
if (typeof window !== 'undefined') {
  const tm = (insforge as any).tokenManager;
  const httpClient = insforge.getHttpClient();

  // Flag to prevent session cleanup during hydration phase
  let isHydratingSession = true;

  const syncSessionToLocalStorage = () => {
    // Session validation and cleanup MUST NOT run during hydration
    if (isHydratingSession) return;

    if (tm && httpClient) {
      const session = tm.getSession();
      const refreshToken = (httpClient as any).refreshToken;
      if (session && session.accessToken) {
        localStorage.setItem('vents_auth_session', JSON.stringify({
          accessToken: session.accessToken,
          refreshToken: refreshToken,
          user: session.user
        }));
      } else {
        localStorage.removeItem('vents_auth_session');
      }
    }
  };

  // Step 1: Restore raw session from localStorage
  const savedSessionStr = localStorage.getItem('vents_auth_session');
  if (savedSessionStr) {
    try {
      const savedSession = JSON.parse(savedSessionStr);
      
      // Step 2: Set access token
      if (savedSession.accessToken) {
        insforge.setAccessToken(savedSession.accessToken);
      }
      
      // Step 3: Set refresh token
      if (savedSession.refreshToken) {
        httpClient.setRefreshToken(savedSession.refreshToken);
      }
      
      // Step 4: Set user object LAST
      if (savedSession.user && tm) {
        tm.setUser(savedSession.user);
      }
    } catch (e) {
      console.error('Failed to parse saved session:', e);
    }
  }

  // Step 5: Only after all steps, allow any session validation logic
  isHydratingSession = false;

  if (tm) {
    const originalSaveSession = tm.saveSession;
    tm.saveSession = function (session: any) {
      originalSaveSession.call(this, session);
      syncSessionToLocalStorage();
    };

    const originalClearSession = tm.clearSession;
    tm.clearSession = function () {
      originalClearSession.call(this);
      syncSessionToLocalStorage();
    };
  }

  if (httpClient) {
    const originalSetRefreshToken = httpClient.setRefreshToken;
    httpClient.setRefreshToken = function (token: string | null) {
      originalSetRefreshToken.call(this, token);
      syncSessionToLocalStorage();
    };
  }
}
