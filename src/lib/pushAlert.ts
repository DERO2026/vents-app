// PushAlert.co web push SDK. Loaded lazily via initPushAlert() (called once
// from a top-level useEffect in App.tsx) rather than a blocking inline
// script in index.html, so a slow/blocked/failed load can never crash app
// startup.
//
// Root cause of the original regression: once the vendor script finishes
// loading, it REPLACES window.PushAlertCo with its own internal SDK state
// object (pa_id, domain, subs_id, ...) — that object has no .push method at
// all. `window.PushAlertCo?.push(...)` only guards against PushAlertCo being
// null/undefined; it still throws "PushAlertCo.push is not a function" once
// the object exists but push() isn't one of its methods. Every call site
// here checks that push is actually a function, not just that PushAlertCo
// is truthy.
declare global {
  interface Window {
    PushAlertCo?: any;
    paDisablePushPrompt?: boolean;
  }
}

function pushAlertQueue(entry: unknown[]) {
  if (typeof window.PushAlertCo?.push === 'function') {
    window.PushAlertCo.push(entry);
  }
}

let initialized = false;

/** Injects the PushAlert script at most once per page load. Safe to call
 * from multiple components/effects — subsequent calls are no-ops. */
export function initPushAlert(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (initialized) return;
  if (document.querySelector('script[src*="cdn.pushalert.co"]')) {
    initialized = true;
    return;
  }
  initialized = true;

  try {
    window.paDisablePushPrompt = true;
    // Pre-declare the queue array so any push() calls made before the
    // vendor script finishes loading are queued instead of throwing —
    // this stub was missing from the previous inline snippet.
    window.PushAlertCo = window.PushAlertCo || [];

    const script = document.createElement('script');
    script.src = 'https://cdn.pushalert.co/integrate_be1188a61752af971d519863076f1388.js';
    script.async = true;
    script.onerror = () => {
      console.warn('[PushAlert] Failed to load — likely blocked by an ad blocker or offline. Push notifications will be unavailable this session.');
    };
    document.head.appendChild(script);
  } catch (err) {
    console.warn('[PushAlert] Initialization failed:', err);
  }
}

export function trackPushEvent(eventName: string, properties?: Record<string, string>) {
  pushAlertQueue(['track', eventName, properties || {}]);
}

export function setPushAlertSubscriber(userId: string, email: string) {
  pushAlertQueue(['setAttribute', 'user_id', userId]);
  pushAlertQueue(['setAttribute', 'email', email]);
}
