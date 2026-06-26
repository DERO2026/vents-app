import posthog from 'posthog-js';

export function initAnalytics(key: string) {
  if (!key) return;
  posthog.init(key, {
    api_host: 'https://app.posthog.com',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
  });
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  try { posthog.capture(event, properties); } catch {}
}

export function identifyUser(userId: string, properties?: Record<string, unknown>) {
  try { posthog.identify(userId, properties); } catch {}
}
