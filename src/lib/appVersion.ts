// Single source of truth for the user-facing app version/brand footer
// ("VENTS v1.1.0 | © VENTS LTD") shown across Welcome, Profile, Settings,
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
export const APP_VERSION = '1.1.0';
export const APP_BRAND = 'VENTS LTD';

export function appVersionLabel(): string {
  return `VENTS v${APP_VERSION} | © ${APP_BRAND}`;
}
