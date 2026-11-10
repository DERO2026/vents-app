// Single source of truth for the user-facing app version/brand footer
// ("VENTS v1.3.0 | © VENTS LTD") shown across Welcome, Profile, Settings,
// and the Admin Console. Previously this string was hand-typed
// identically in four separate files -- a version bump meant remembering
// to find and edit all four, and they had already drifted in practice
// (a plain "|" vs "·" separator, admin's extra trailing note). Bump
// APP_VERSION here and every displayed instance updates.
//
// Deliberately independent of package.json's "version" field (0.0.1) --
// that's npm's own internal package versioning, unrelated to this
// marketing/build version shown to users, and conflating the two would
// make an ordinary dependency bump silently change what users see.
// Also the version the forced-update gate compares with
// app_config.min_client_version (App.tsx), and it must equal Android's
// versionName and iOS's MARKETING_VERSION (checked by both native workflows).
export const APP_VERSION = '1.3.0';
export const APP_BRAND = 'VENTS LTD';

export function appVersionLabel(): string {
  return `VENTS v${APP_VERSION} | © ${APP_BRAND}`;
}

/** True when version `current` is older than `minimum` (dotted numbers, missing parts are 0). */
export function isVersionOlder(current: string, minimum: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0);
  const b = minimum.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

// Official, live VENTS store listings -- never fabricate or alter these.
export const APP_STORE_URL = 'https://apps.apple.com/ng/app/vents-events/id6802584284';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.getvents.app';

/** Where the update-required screen sends the user: the store on native, a reload on the web. */
export function updateTarget(platform: string): { label: string; url: string | null; body: string } {
  if (platform === 'ios') {
    return { label: 'Update on the App Store', url: APP_STORE_URL, body: 'This version of VENTS is no longer supported. Update the app from the App Store to continue.' };
  }
  if (platform === 'android') {
    return { label: 'Update on Google Play', url: PLAY_STORE_URL, body: 'This version of VENTS is no longer supported. Update the app from Google Play to continue.' };
  }
  return { label: 'Reload VENTS', url: null, body: 'A new version of VENTS is available. Reload the page to continue.' };
}
