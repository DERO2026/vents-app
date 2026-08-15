import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

// Same platform split as insforge.ts's SESSION_KEY storage: the Supabase
// JS client already handles token refresh/rotation internally, so this
// adapter only needs to satisfy its Storage interface (getItem/setItem/
// removeItem) - no manual refresh logic required here, unlike the InsForge
// client this replaces.
const isNative = Capacitor.isNativePlatform();

const secureStorageAdapter = {
  getItem: (key: string) => SecureStorage.getItem(key) as Promise<string | null>,
  setItem: (key: string, value: string) => SecureStorage.setItem(key, value).then(() => undefined),
  removeItem: (key: string) => SecureStorage.removeItem(key).then(() => undefined),
};

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storage: isNative ? secureStorageAdapter : window.localStorage,
      storageKey: 'vents_supabase_auth',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: !isNative,
    },
  }
);

/**
 * Returns the current authenticated access token, refreshing if necessary.
 * Direct replacement for insforge.ts's getAuthToken() - same signature,
 * same "safe to call before any storage upload, works after a page
 * refresh" contract, but backed by the Supabase client's own session
 * management instead of manual refresh-token plumbing.
 */
export async function getAuthToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    throw new Error('Session expired. Please sign out and sign back in, then try again.');
  }
  return data.session.access_token;
}
