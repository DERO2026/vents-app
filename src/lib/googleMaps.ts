// Lazy, singleton loader for the Google Maps JS API, using Google's official
// inline bootstrap snippet (https://goo.gle/js-api-loading) so
// `google.maps.importLibrary()` is actually wired up — a plain <script src>
// tag does NOT set that up on its own, even with `loading=async` in the URL.
//
// The legacy `google.maps.places.Autocomplete` widget is blocked for API
// keys created after March 2025 (Google's "Places API (New)" migration) —
// this project's key only has Places API (New) + Maps JavaScript API
// enabled, so every consumer here MUST use the modern
// `google.maps.places.PlaceAutocompleteElement` instead.
let loadPromise: Promise<void> | null = null;

// Google calls window.gm_authFailure when the API key's request is
// rejected server-side (most commonly an HTTP referrer restriction that
// doesn't cover the caller's origin — e.g. a key allowlisted for
// getvents.com but not for the native app's WebView origin, https://localhost
// on Android / capacitor://localhost on iOS). Critically, this happens
// AFTER the script tag itself loads successfully and after
// google.maps.importLibrary() has already resolved — so without this hook
// every caller sees a false "ready" state and Google paints its own
// authentication-error UI directly into whatever div holds the map,
// indistinguishable from "the app is broken" to a user. Registered
// unconditionally at module load (not per-call) since Google looks up this
// global by name whenever the failure occurs, however many times
// loadGoogleMaps() has been called.
let rejectOnAuthFailure: ((err: Error) => void) | null = null;
const authFailure = new Promise<never>((_, reject) => { rejectOnAuthFailure = reject; });
(window as any).gm_authFailure = () => {
  // This is the one piece of diagnostic infrastructure that actually
  // matters here: this failure only reproduces on a real device we don't
  // have physical/DevTools access to. Reporting it to Sentry (already
  // wired into this app) is the only way to see it happen remotely instead
  // of guessing at Google Cloud Console settings blind. The origin/href are
  // exactly what determines whether the API key's referrer allowlist
  // matches, so they're the first thing to check in the captured event.
  const context = { origin: window.location.origin, href: window.location.href, userAgent: navigator.userAgent };
  console.error('Google Maps: authentication failed — check the API key\'s HTTP referrer restrictions cover this app\'s actual origin.', context);
  import('./sentry').then(({ Sentry }) => {
    Sentry.captureMessage('Google Maps gm_authFailure — API key rejected this origin', {
      level: 'error',
      extra: context,
    });
  }).catch(() => {});
  rejectOnAuthFailure?.(new Error('Google Maps authentication failed — this app\'s origin is not allowed by the API key\'s referrer restrictions.'));
};

export function loadGoogleMaps(): Promise<void> {
  if (loadPromise) return loadPromise;

  const apiKey = import.meta.env.VITE_GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error('Location search is not configured.'));
  }

  const w = window as any;

  // Google's official bootstrap loader (minified as distributed) — sets up
  // `google.maps.importLibrary` without eagerly loading every library.
  if (!w.google?.maps?.importLibrary) {
    (((g) => {
      let h: any, a: any, k: any;
      const p = 'The Google Maps JavaScript API';
      const c = 'google';
      const l = 'importLibrary';
      const q = '__ib__';
      const m = document;
      let b: any = window as any;
      b = b[c] || (b[c] = {});
      const d = b.maps || (b.maps = {});
      const r = new Set();
      const e = new URLSearchParams();
      const u = () =>
        h ||
        (h = new Promise(async (f, n) => {
          a = m.createElement('script');
          e.set('libraries', [...r] + '');
          for (k in g) e.set(k.replace(/[A-Z]/g, (t: string) => '_' + t[0].toLowerCase()), (g as any)[k]);
          e.set('callback', c + '.maps.' + q);
          a.src = `https://maps.${c}apis.com/maps/api/js?${e}`;
          d[q] = f;
          a.onerror = () => (h = n(Error(p + ' could not load.')));
          a.nonce = (m.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce || '';
          m.head.append(a);
        }));
      d[l] ? console.warn(p + ' only loads once. Ignoring:', g) : (d[l] = (f: any, ...n: any[]) => r.add(f) && u().then(() => d[l](f, ...n)));
    })({ key: apiKey, v: 'weekly' }));
  }

  loadPromise = Promise.race([
    (async () => {
      const google = w.google;
      await Promise.all([
        google.maps.importLibrary('places'),
        google.maps.importLibrary('geocoding'),
        google.maps.importLibrary('maps'),
        google.maps.importLibrary('marker'),
      ]);
    })(),
    authFailure,
  ]);

  // A failure (flaky network, ad-blocker, transient CORS hiccup) must not
  // be cached forever — the next caller (e.g. the user retrying) should get
  // a fresh attempt instead of an immediately-rejected stale promise.
  loadPromise.catch(() => { loadPromise = null; });

  return loadPromise;
}
