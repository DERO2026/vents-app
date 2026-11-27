import { describe, it, expect, vi, beforeEach } from 'vitest';

// Session persistence (P0 login investigation, 2026-11-27): a successful
// sign-in must survive a reload / app restart, refresh itself, and sign-out
// must clear the stored session. Every installed build and the website read
// the same storage key, so it must never change silently (users would be
// signed out en masse). Web: localStorage. iOS/Android: Keychain/Keystore
// (SecureStorage), never localStorage.

const createClient = vi.fn(() => ({ auth: {} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: any[]) => (createClient as any)(...a) }));
const isNativePlatform = vi.fn(() => false);
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => isNativePlatform() } }));
const secure = { getItem: vi.fn(async () => 'stored'), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) };
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: secure }));
vi.mock('./previewReadOnly', () => ({ installPreviewReadOnlyGuard: vi.fn() }));

async function load(native: boolean) {
  vi.resetModules(); createClient.mockClear(); isNativePlatform.mockReturnValue(native);
  await import('./supabase');
  return (createClient.mock.calls[0] as any[])[2].auth;
}

beforeEach(() => { (globalThis as any).__VENTS_PREVIEW_READ_ONLY__ = false; });

describe('Supabase session persistence', () => {
  it('web: persists the session in localStorage under the fixed key, refreshes tokens, reads the email-link session', async () => {
    const auth = await load(false);
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
    expect(auth.storageKey).toBe('vents_supabase_auth');
    expect(auth.storage).toBe(window.localStorage);
    expect(auth.detectSessionInUrl).toBe(true);
  });

  it('native: the session lives in SecureStorage (Keychain/Keystore), never localStorage; set/get/remove pass through', async () => {
    const auth = await load(true);
    expect(auth.storage).not.toBe(window.localStorage);
    expect(auth.storageKey).toBe('vents_supabase_auth');
    expect(auth.persistSession).toBe(true);
    expect(auth.detectSessionInUrl).toBe(false);
    await auth.storage.setItem('vents_supabase_auth', 'tok');
    expect(secure.setItem).toHaveBeenCalledWith('vents_supabase_auth', 'tok');
    expect(await auth.storage.getItem('vents_supabase_auth')).toBe('stored');
    await auth.storage.removeItem('vents_supabase_auth'); // what signOut() does
    expect(secure.removeItem).toHaveBeenCalledWith('vents_supabase_auth');
  });
});
