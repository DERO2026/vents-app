import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Production report: tapping Settings -> Payments -> Representatives
// produced a black screen on getvents.com, with a captured console error
// "'text/html' is not a valid JavaScript MIME type" -- the signature of a
// <script>/import() request for a JS asset receiving an HTML response
// instead (normally a 404 page, or here, vercel.json's SPA catch-all
// serving /index.html for a path it doesn't recognize).
//
// Ruled out as the cause (confirmed, not assumed):
//   - RepresentativesScreen is NOT lazy-loaded (no React.lazy/import() on
//     its render path) -- it's a static import in App.tsx, bundled with
//     the rest of the app, not a separate chunk that could 404 on its own.
//   - An ordinary React render-phase exception in RepresentativesScreen
//     would have been caught by the existing ErrorBoundary that already
//     wraps the whole screen-switch block in App.tsx (and by the root
//     Sentry.ErrorBoundary in main.tsx above that) -- both render a
//     visible "Something went wrong" fallback, not a blank screen. The
//     user saw neither fallback, which is the opposite of what an ordinary
//     component crash would produce.
//
// What *is* consistent with a blank screen plus that exact console error:
// a module/script load failure happening before React (and therefore
// before either ErrorBoundary) ever runs. The concrete, confirmed gap that
// causes this: vercel.json's rewrites had no Cache-Control headers on
// index.html/the root path, so a browser (or an intermediate cache) could
// keep serving an index.html from *before* a deploy, whose <script> tags
// reference a content-hashed JS filename that the *current* deployment no
// longer has on disk -- the request for that stale filename finds no
// matching static file, falls through to the SPA catch-all
// (`/(.*) -> /index.html`), and comes back as text/html where the browser
// expected JavaScript. This repo deployed three merges back-to-back
// immediately before this report (PR #48, #49, #50) -- exactly the
// high-risk window for a browser to have a stale index.html in hand.
//
// Fix: explicit Cache-Control headers -- `no-cache, must-revalidate` on
// `/` and `/index.html` so every navigation re-fetches current HTML (and
// therefore current asset hashes), and `public, max-age=31536000,
// immutable` on `/assets/(.*)` (safe because Vite's content-hashed
// filenames change whenever the content does, so caching them forever is
// correct, not stale).

describe('vercel.json: index.html is never served from a stale cache', () => {
  let config: { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };

  beforeAll(() => {
    config = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
  });

  function headerFor(source: string, key: string): string | undefined {
    const rule = config.headers.find((h) => h.source === source);
    return rule?.headers.find((h) => h.key === key)?.value;
  }

  it('sets no-cache/must-revalidate on the root path, so index.html is always re-fetched', () => {
    const value = headerFor('/', 'Cache-Control');
    expect(value).toBeDefined();
    expect(value).toMatch(/no-cache/);
    expect(value).toMatch(/must-revalidate/);
  });

  it('sets no-cache/must-revalidate on /index.html explicitly', () => {
    const value = headerFor('/index.html', 'Cache-Control');
    expect(value).toBeDefined();
    expect(value).toMatch(/no-cache/);
    expect(value).toMatch(/must-revalidate/);
  });

  it('allows content-hashed /assets/* files to be cached immutably forever (safe: filename changes with content)', () => {
    const value = headerFor('/assets/(.*)', 'Cache-Control');
    expect(value).toBeDefined();
    expect(value).toMatch(/immutable/);
    expect(value).toMatch(/max-age=31536000/);
  });
});

// Round 2/3 investigation: the user reported the black screen PERSISTING
// after the cache-header fix above shipped and was verified live. Rather
// than assume that fix was wrong, this was re-investigated with actual
// evidence: the real production bundle was built, served under the exact
// live Content-Security-Policy header, and loaded in real headless
// Chromium (not jsdom) -- zero CSP violations, the app booted normally.
// RepresentativesScreen was also mounted in isolation in real Chromium
// under total simulated network failure (every Supabase request failing)
// -- with the try/catch hardening already on this branch, it rendered its
// title, a visible loading state, and all three sub-tabs; it did not go
// blank. Both of the component-level and CSP-level theories for a
// *continuing* black screen are therefore ruled out by direct experiment,
// not just reasoning. The CSP's connect-src must keep allowing the
// Supabase REST/Realtime origins this screen depends on -- if that were
// ever narrowed, every RPC call here would fail at the network layer
// before the component's own error handling even gets a chance to run.
describe('vercel.json: CSP keeps allowing what RepresentativesScreen depends on', () => {
  let config: { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };

  beforeAll(() => {
    config = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
  });

  it("connect-src still allows the Supabase REST/Realtime origins RepresentativesScreen's RPC calls depend on", () => {
    const rule = config.headers.find((h) => h.source === '/((?!embed/).*)');
    const csp = rule?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    const connectSrc = csp.split(';').find((d) => d.trim().startsWith('connect-src')) ?? '';
    expect(connectSrc).toMatch(/https:\/\/\*\.supabase\.co/);
    expect(connectSrc).toMatch(/wss:\/\/\*\.supabase\.co/);
  });
});

describe('RepresentativesScreen: cannot fail silently into a blank screen', () => {
  let appSource: string;
  let screenSource: string;

  beforeAll(() => {
    appSource = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
    screenSource = readFileSync(join(__dirname, '..', 'app', 'components', 'RepresentativesScreen.tsx'), 'utf8');
  });

  it('is not lazy-loaded (so it cannot be the target of a standalone chunk-load failure)', () => {
    expect(appSource).toMatch(/import \{ RepresentativesScreen \} from '\.\/components\/RepresentativesScreen';/);
    expect(appSource).not.toMatch(/lazy\(\(\) => import\(['"]\.\/components\/RepresentativesScreen['"]\)/);
  });

  it("is rendered inside App.tsx's screen-switch block, which the local <ErrorBoundary> wraps", () => {
    const errorBoundaryOpenIdx = appSource.indexOf('<ErrorBoundary>');
    const representativesRenderIdx = appSource.indexOf("screen === 'representatives'");
    expect(errorBoundaryOpenIdx).toBeGreaterThan(-1);
    expect(representativesRenderIdx).toBeGreaterThan(errorBoundaryOpenIdx);
  });

  it('shows an explicit loading indicator while recruiter status is still being checked, instead of rendering nothing', () => {
    expect(screenSource).toMatch(/isRecruiter === null && !statusError/);
    expect(screenSource).toMatch(/data-testid="representatives-loading"/);
  });
});
