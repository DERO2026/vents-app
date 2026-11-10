import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import {
  isChunkLoadError, recoverFromChunkError, consumeResumeScreen, lazyImportWithRecovery, installChunkRecovery,
  __resetChunkRecoveryForTests, RELOAD_MARKER_KEY, RESUME_SCREEN_KEY, RELOAD_WINDOW_MS, type RecoveryDeps,
} from './chunkRecovery';

// Production error JAVASCRIPT-REACT-2G (2026-11-10, iPhone Safari):
// "TypeError: Importing a module script failed" -- a tab loaded before a
// deploy asked for a lazy chunk (AdminConsoleShell-<oldhash>.js) that the new
// deployment no longer has. These tests pin the recovery: one controlled
// reload, never a loop, the user's screen kept, the error still reported.

const SAFARI = new TypeError('Importing a module script failed.');
const CHROME = new TypeError('Failed to fetch dynamically imported module: https://getvents.com/assets/AdminConsoleShell-DAp5YxUR.js');
const FIREFOX = new TypeError('error loading dynamically imported module: https://getvents.com/assets/x.js');

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

function deps(over: Partial<RecoveryDeps> = {}) {
  const storage = memoryStorage();
  let t = 1_000_000;
  const d = {
    storage,
    reload: vi.fn(),
    now: () => t,
    report: vi.fn(),
    currentScreen: () => 'admin-console',
    ...over,
  };
  return { d, storage, advance: (ms: number) => { t += ms; } };
}

beforeEach(() => { __resetChunkRecoveryForTests(); });

describe('isChunkLoadError', () => {
  it('recognises the Safari, Chrome and Firefox dynamic-import failures and HTML-served-as-JS', () => {
    for (const e of [SAFARI, CHROME, FIREFOX, new Error("'text/html' is not a valid JavaScript MIME type."), Object.assign(new Error('x'), { name: 'ChunkLoadError' })]) {
      expect(isChunkLoadError(e)).toBe(true);
    }
  });
  it('ignores ordinary errors', () => {
    for (const e of [new Error('Network request failed'), new TypeError('undefined is not a function'), null, undefined, { message: 42 }]) {
      expect(isChunkLoadError(e)).toBe(false);
    }
  });
});

describe('recoverFromChunkError', () => {
  it('reloads once, remembers the screen, and still reports the error', () => {
    const { d, storage } = deps();
    expect(recoverFromChunkError(SAFARI, d)).toBe('reloading');
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.map.get(RELOAD_MARKER_KEY)!)).toMatchObject({ at: 1_000_000, build: 'test-build' });
    expect(storage.map.get(RESUME_SCREEN_KEY)).toBe('admin-console');
    expect(d.report).toHaveBeenCalledWith(SAFARI, 'reloading');
  });

  it('never reloads twice in a row: a repeat within the window is reported and left to the error screen', () => {
    const { d, advance } = deps();
    recoverFromChunkError(SAFARI, d);
    advance(30_000);
    expect(recoverFromChunkError(SAFARI, d)).toBe('already_reloaded');
    advance(RELOAD_WINDOW_MS - 31_000);
    expect(recoverFromChunkError(CHROME, d)).toBe('already_reloaded');
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.report).toHaveBeenLastCalledWith(CHROME, 'already_reloaded');
  });

  it('allows one more reload only after the window (a later deploy)', () => {
    const { d, advance } = deps();
    recoverFromChunkError(SAFARI, d);
    advance(RELOAD_WINDOW_MS + 1);
    expect(recoverFromChunkError(SAFARI, d)).toBe('reloading');
    expect(d.reload).toHaveBeenCalledTimes(2);
  });

  it('without storage (private mode, blocked) it never reloads, so it cannot loop', () => {
    const { d } = deps({ storage: null });
    expect(recoverFromChunkError(SAFARI, d)).toBe('no_storage');
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.report).toHaveBeenCalledWith(SAFARI, 'no_storage');
  });

  it('if the marker cannot be written it does not reload', () => {
    const s = memoryStorage();
    const { d } = deps({ storage: { ...s, setItem: () => { throw new Error('QuotaExceeded'); } } });
    expect(recoverFromChunkError(SAFARI, d)).toBe('no_storage');
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('a corrupted marker is treated as no earlier reload', () => {
    const { d, storage } = deps();
    storage.setItem(RELOAD_MARKER_KEY, '{not json');
    expect(recoverFromChunkError(SAFARI, d)).toBe('reloading');
  });

  it('does nothing for an error that is not a chunk failure', () => {
    const { d } = deps();
    expect(recoverFromChunkError(new Error('boom'), d)).toBe('not_chunk_error');
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.report).not.toHaveBeenCalled();
  });
});

describe('consumeResumeScreen', () => {
  it('returns the remembered screen once', () => {
    const s = memoryStorage();
    s.setItem(RESUME_SCREEN_KEY, 'admin-console');
    expect(consumeResumeScreen(s)).toBe('admin-console');
    expect(consumeResumeScreen(s)).toBeNull();
    expect(consumeResumeScreen(null)).toBeNull();
  });
});

describe('lazyImportWithRecovery', () => {
  it('a stale chunk reloads and the promise never settles (no crash flash)', async () => {
    const { d } = deps();
    const loader = lazyImportWithRecovery(() => Promise.reject(SAFARI), d);
    let settled = false;
    loader().then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('after the one reload, a repeat failure is thrown to the error boundary', async () => {
    const { d } = deps();
    void lazyImportWithRecovery(() => Promise.reject(SAFARI), d)();
    await Promise.resolve();
    await expect(lazyImportWithRecovery(() => Promise.reject(SAFARI), d)()).rejects.toBe(SAFARI);
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('other errors are thrown unchanged and never reload', async () => {
    const { d } = deps();
    const err = new Error('render bug');
    await expect(lazyImportWithRecovery(() => Promise.reject(err), d)()).rejects.toBe(err);
    expect(d.reload).not.toHaveBeenCalled();
  });

  it('a successful import passes through', async () => {
    const { d } = deps();
    await expect(lazyImportWithRecovery(() => Promise.resolve({ default: 1 }), d)()).resolves.toEqual({ default: 1 });
  });
});

describe('installChunkRecovery', () => {
  it("Vite's preloadError: reloads once and stops Vite from rethrowing; the next one is left alone", () => {
    const shared = deps();
    const target = new EventTarget() as unknown as Window;
    installChunkRecovery(target, () => shared.d);
    const first = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: SAFARI });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: SAFARI });
    target.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    expect(shared.d.reload).toHaveBeenCalledTimes(1);
  });

  it('an unhandled chunk rejection reloads once; other rejections are ignored', () => {
    const shared = deps();
    const target = new EventTarget() as unknown as Window;
    installChunkRecovery(target, () => shared.d);
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('unrelated') }));
    expect(shared.d.reload).not.toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: CHROME }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: CHROME }));
    expect(shared.d.reload).toHaveBeenCalledTimes(1);
  });
});

describe('deployment config: a missing hashed file is never answered with the HTML page', () => {
  const config = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
  const toRegex = (source: string) => new RegExp(`^${source}$`);
  const spa = config.rewrites.find((r: any) => r.destination === '/index.html');

  it('the SPA fallback does not cover /assets/, so a stale chunk gets a 404, not index.html', () => {
    expect(spa).toBeTruthy();
    expect(toRegex(spa.source).test('/assets/AdminConsoleShell-DAp5YxUR.js')).toBe(false);
    expect(toRegex(spa.source).test('/assets/web-QcARhp6p.js')).toBe(false);
  });

  it('every app route still falls back to index.html', () => {
    for (const path of ['/', '/event/123', '/u/ada', '/settings', '/assetsx']) expect(toRegex(spa.source).test(path), path).toBe(true);
  });

  it('index.html is revalidated on every load; hashed assets stay immutable', () => {
    const header = (src: string) => config.headers.find((h: any) => h.source === src)?.headers.find((x: any) => x.key === 'Cache-Control')?.value;
    expect(header('/')).toMatch(/no-cache/);
    expect(header('/index.html')).toMatch(/no-cache/);
    expect(header('/assets/(.*)')).toMatch(/immutable/);
  });

  it('the lazy Admin Console import goes through the recovery wrapper, and the app installs the global handlers', () => {
    const app = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
    expect(app).toMatch(/const AdminConsoleShell = lazy\(lazyImportWithRecovery\(/);
    expect(app).toMatch(/isChunkLoadError\(this\.state\.error\)/);
    expect(readFileSync(join(__dirname, '..', 'main.tsx'), 'utf8')).toMatch(/installChunkRecovery\(\);/);
  });
});
