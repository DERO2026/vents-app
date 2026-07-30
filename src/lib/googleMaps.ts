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

  loadPromise = (async () => {
    const google = w.google;
    await Promise.all([
      google.maps.importLibrary('places'),
      google.maps.importLibrary('geocoding'),
      google.maps.importLibrary('maps'),
      google.maps.importLibrary('marker'),
    ]);
  })();

  // A failure (flaky network, ad-blocker, transient CORS hiccup) must not
  // be cached forever — the next caller (e.g. the user retrying) should get
  // a fresh attempt instead of an immediately-rejected stale promise.
  loadPromise.catch(() => { loadPromise = null; });

  return loadPromise;
}
