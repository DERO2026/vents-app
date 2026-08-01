import { Capacitor } from '@capacitor/core';

// Capacitor serves the app from a local scheme (capacitor://localhost on
// iOS, https://localhost on Android), not from getvents.com — a relative
// fetch('/api/...') resolves against that local origin, which has no
// dev server or Vercel rewrite behind it, and 404s. On web the app IS
// served from getvents.com, so a relative path is correct and preferred
// (same-origin, no CORS preflight). VITE_API_BASE lets a specific native
// build target a different origin (e.g. a staging deploy) without a code
// change; it defaults to production.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || 'https://getvents.com';

/** Resolves a same-origin-relative API path to an absolute URL when running
 * inside Capacitor (native), or returns it unchanged on web. */
export function apiUrl(path: string): string {
  if (!Capacitor.isNativePlatform()) return path;
  return `${API_BASE}${path}`;
}
