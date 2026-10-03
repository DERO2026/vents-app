// Per-device on/off switch for the VENTS AI floating orb (see
// VentsAiOrb.tsx / App.tsx's shouldShowVentsAiOrb gate), toggled from
// Settings. Defaults to enabled (true) so existing users see no change in
// behavior until they explicitly turn it off -- only ever reduces to
// "don't show the orb", never grants anything. Device-local by design (a
// UI display preference, not account data), mirroring this app's existing
// client-side-only caches rather than adding a users-table column/RPC for
// a purely cosmetic toggle. Wrapped in try/catch: a private-browsing tab or
// a storage-disabled environment must never crash the app over a feature
// that's enabled by default anyway.

const KEY = 'vents_ai_enabled';

export function isVentsAiEnabled(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function setVentsAiEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? 'true' : 'false');
  } catch {
    /* private browsing / storage disabled -- the in-memory App.tsx state
       this session still reflects the toggle, it just won't persist */
  }
}
