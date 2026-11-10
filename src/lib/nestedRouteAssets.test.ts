// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import viteConfig from '../../vite.config';

// Regression: opening a nested URL directly (getvents.com/event/abc, or a
// refresh there) showed a blank page. vite.config.ts had base: './', so the
// built index.html loaded ./assets/main-*.js, which the browser resolved
// against the current path: /event/assets/main-*.js. That file does not exist,
// the SPA fallback answered it with index.html, and the module never ran.
// Fix: an absolute base ('/'), and the SPA fallback never answers any
// .../assets/... request with HTML (a missing chunk stays a 404, PR #99).

const root = join(__dirname, '..', '..');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const rewrites: { source: string; destination: string }[] = vercel.rewrites;
const spa = rewrites.find((r) => r.destination === '/index.html')!;
// Vercel compiles "source" with path-to-regexp; for these patterns that is
// exactly ^source$ (checked against path-to-regexp 6.1 and 6.3 when this
// was written).
const spaMatches = (path: string) => new RegExp(`^${spa.source}$`).test(path);

const NESTED = ['/event/abc', '/event/00000000-0000-0000-0000-000000000001', '/u/someone', '/work/rep/dashboard', '/a/b/c/d'];

describe('assets load from any URL depth', () => {
  it('the build base is absolute', async () => {
    const cfg = await (viteConfig as any)({ mode: 'development', command: 'build' });
    expect(cfg.base).toBe('/');
  });

  it('an absolute asset URL resolves to /assets/ from every route (a relative one did not)', () => {
    for (const page of ['/', ...NESTED, '/?event=1', '/terms']) {
      expect(new URL('/assets/main-abc123.js', `https://getvents.com${page}`).pathname, page).toBe('/assets/main-abc123.js');
    }
    // The bug, pinned: what base './' produced on a nested page.
    expect(new URL('./assets/main-abc123.js', 'https://getvents.com/event/abc').pathname).toBe('/event/assets/main-abc123.js');
  });

  it('index.html source references its module, styles and icons by absolute path', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
    expect(refs.length).toBeGreaterThan(0);
    for (const u of refs) expect(u, u).toMatch(/^\//);
  });
});

describe('vercel.json routing', () => {
  it('every app route, nested or not, falls back to index.html', () => {
    for (const p of ['/', ...NESTED, '/terms', '/privacy', '/refunds', '/assetsx', '/u/assets-team', '/my-assets/x']) {
      expect(spaMatches(p), p).toBe(true);
    }
  });

  it('a hashed asset is never answered with index.html, at any depth (a missing chunk is a 404)', () => {
    for (const p of ['/assets/main-abc.js', '/assets/AdminConsoleShell-OLDHASH.js', '/event/assets/main-abc.js', '/a/b/assets/x.css']) {
      expect(spaMatches(p), p).toBe(false);
    }
  });

  it('the API and /help rewrites come before the SPA fallback', () => {
    const idx = (s: string) => rewrites.findIndex((r) => r.source === s);
    const spaIdx = rewrites.indexOf(spa);
    expect(idx('/api/v1/(.*)')).toBeLessThan(spaIdx);
    expect(idx('/api/(.*)')).toBeLessThan(spaIdx);
    expect(idx('/help')).toBeLessThan(spaIdx);
    expect(rewrites[idx('/help')].destination).toBe('/help.html');
  });

  it('caching is unchanged: index.html revalidates, hashed assets are immutable', () => {
    const cc = (src: string) => vercel.headers.find((h: any) => h.source === src)?.headers.find((x: any) => x.key === 'Cache-Control')?.value;
    expect(cc('/')).toMatch(/no-cache/);
    expect(cc('/index.html')).toMatch(/no-cache/);
    expect(cc('/assets/(.*)')).toMatch(/immutable/);
  });
});
