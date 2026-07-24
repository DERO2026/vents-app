import posthog from 'posthog-js';

// PostHog ingestion moved off app.posthog.com — that host is deprecated for
// event capture and increasingly returns errors / gets blocked, which is why
// events stopped landing. The current endpoints are region-specific reverse
// proxies: us.i.posthog.com / eu.i.posthog.com for ingestion, with a separate
// ui_host for the "view in PostHog" links. Both are overridable via env so the
// region can be switched without a code change.
const DEFAULT_API_HOST = 'https://us.i.posthog.com';
const DEFAULT_UI_HOST = 'https://us.posthog.com';

let started = false;

export function initAnalytics(key: string) {
  // No key → nothing to send to. Warn once so a missing VITE_POSTHOG_KEY in the
  // deploy env is visible in the console instead of failing silently.
  if (!key) {
    if (import.meta.env.PROD) console.warn('[analytics] VITE_POSTHOG_KEY is not set — analytics disabled.');
    return;
  }
  if (started) return;
  started = true;

  const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string) || DEFAULT_API_HOST;
  const uiHost = (import.meta.env.VITE_POSTHOG_UI_HOST as string) || DEFAULT_UI_HOST;

  try {
    posthog.init(key, {
      api_host: apiHost,
      ui_host: uiHost,
      // The app is a state-machine SPA: navigation swaps a `screen` state value
      // and NEVER changes the URL (react-router is a dep but unused). PostHog's
      // automatic pageview capture only fires on load + History API changes, so
      // it would only ever record the first view and nothing as users navigate.
      // We drive $pageview manually from the navigation state instead (see
      // capturePageview + the effect in App.tsx), which also guarantees the
      // initial view — so automatic capture is turned off to avoid a duplicate.
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      // Don't create anonymous person profiles for every visitor — only once a
      // user is identified. Keeps the event volume (and bill) sane.
      person_profiles: 'identified_only',
      // Surface transport failures during development instead of swallowing them.
      loaded: (ph) => {
        if (import.meta.env.DEV) ph.debug();
      },
    });
  } catch (err) {
    console.warn('[analytics] PostHog init failed:', err);
  }
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  try { posthog.capture(event, properties); } catch {}
}

/**
 * Manually record a $pageview for our state-based navigation. Because the real
 * URL never changes, we synthesise a $current_url / $pathname from the screen
 * name so PostHog groups views into distinct "pages" (e.g. /home, /event-details)
 * in Activity and the web-analytics UI.
 */
export function capturePageview(path: string, properties?: Record<string, unknown>) {
  try {
    const clean = '/' + String(path).replace(/^\/+/, '');
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    posthog.capture('$pageview', {
      $current_url: origin + clean,
      $pathname: clean,
      ...properties,
    });
  } catch {}
}

export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  try { posthog.identify(userId, properties); } catch {}
}
