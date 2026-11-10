# Stale deployments and chunk-load failures

**Sentry:** JAVASCRIPT-REACT-2G, "TypeError: Importing a module script failed", iPhone Safari, getvents.com/, 2026-11-10.

## Cause

Every Vercel deployment publishes new content-hashed files under `/assets/`, and getvents.com stops serving the previous deployment's files.

A page loaded before a deploy still runs the old `main-*.js`. Examples:
- a tab left open;
- an iOS Safari page restored from the background.

The next lazy import that page makes asks for an old file. The one lazy chunk a web visitor normally loads is the Admin Console, `AdminConsoleShell-<hash>.js`. The Capacitor plugin chunks are only used inside the native app.

Before this fix, `vercel.json`'s SPA rewrite `/(.*) → /index.html` also matched `/assets/*`. A missing chunk was therefore answered with:
- **index.html**;
- status **200**;
- `content-type: text/html`;
- `Cache-Control: public, max-age=31536000, immutable`, from the `/assets/(.*)` header rule.

Vercel's edge cached that response. Safari reported the HTML-for-JS response as "Importing a module script failed". The app's top-level error boundary then replaced the whole app with an "Application Crash" screen, which stayed until the user reloaded by hand.

The admin chunk changed hash on most deploys on 2026-11-10 (`C4c6HPWg` → `DAp5YxUR` → `DNDRC4qu`). Requesting the older one on getvents.com returned the HTML page.

## Fix

1. **`vercel.json`:** the SPA rewrite is `/((?!(?:[^/]+/)*assets/).*)` (originally `/((?!assets/).*)`; widened so an `.../assets/...` request at any depth is never answered with HTML). A missing hashed file now gets a 404 instead of a year-cacheable copy of index.html. index.html itself stays `no-cache, must-revalidate`, so a reload always fetches the current deployment's file names.
2. **`src/lib/chunkRecovery.ts`** recognises the WebKit, Chrome and Firefox chunk-failure messages, and HTML served as JS. On a chunk failure it:
   - reloads the page **once per tab per 10 minutes**, guarded by a `sessionStorage` marker. If storage is unavailable or fails, it never reloads, so it can't loop;
   - keeps the URL (path, query and hash) and remembers the in-app screen. An admin who was opening the Admin Console is returned to it after the reload;
   - reports every occurrence to Sentry with the tags `chunk_load_error` and `chunk_recovery`: `reloading`, `already_reloaded` or `no_storage`. The error is not suppressed.
3. **Where recovery is wired in:**
   - **The Admin Console lazy import** uses `lazyImportWithRecovery`. While reloading, the import never settles, so the user doesn't see a crash flash.
   - **Global handlers:** Vite's `vite:preloadError` event and `unhandledrejection`, for dynamic imports that nobody catches.
4. **If the failure repeats after the reload** (a genuinely missing file, or no connection), the error boundary shows "VENTS was updated… Reload VENTS" instead of the crash screen with the raw error.
5. **Sentry `release`** is now `vents-web@<commit>`, from `VERCEL_GIT_COMMIT_SHA`, so an error can be tied to the deployment that threw it.

There is no service worker. Vercel Skew Protection, which keeps serving older deployments' assets, is a Pro or Enterprise feature; this project is on Hobby.

## Tests

- `src/lib/chunkRecovery.test.ts`: error detection, one reload, no loop, no-storage safety, screen resume, the lazy wrapper, the global handlers, and the `vercel.json` routing and caching rules.
- A manual Chromium check against the built app: a missing chunk gives exactly one reload with the URL kept, and a second failure gives no reload.

## Nested URLs (follow-up)

`vite.config.ts` had `base: './'`, so index.html loaded `./assets/main-*.js`. Opening a nested URL directly (`/event/abc`, or refreshing there) made the browser request `/event/assets/main-*.js`. The SPA rewrite answered with index.html, and the page stayed blank.

The base is now `/`. Both the web app (domain root) and the native app (WebView root: `https://localhost/`, `capacitor://localhost/`) are served from `/`.

Tests: `src/lib/nestedRouteAssets.test.ts`.
