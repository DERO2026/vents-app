// Recovery from stale-deployment chunk failures.
//
// Every Vercel deployment publishes new content-hashed files under
// /assets/, and the previous deployment's files stop being served at
// getvents.com. A tab (or a backgrounded iOS Safari page) that loaded the
// app before a deploy still holds the OLD main bundle, so the next lazy
// import (the Admin Console, a Capacitor web plugin) asks for an old
// /assets/<name>-<oldhash>.js that no longer exists. Safari reports that as
// "TypeError: Importing a module script failed", Chrome as "Failed to fetch
// dynamically imported module", Firefox as "error loading dynamically
// imported module".
//
// The fix is a fresh copy of the page: index.html is served no-cache, so a
// reload gets the current deployment's bundle and file names. This module
// does that ONCE per tab per RELOAD_WINDOW_MS, remembers which screen the
// user was on, and never reloads in a loop: if the failure repeats after the
// reload (a genuinely missing file, an offline phone), it stops and lets the
// caller show a "reload" message instead. Every recovery is still reported
// to Sentry.
import { Sentry } from './sentry';

export const RELOAD_MARKER_KEY = 'vents:chunk-reload';
export const RESUME_SCREEN_KEY = 'vents:resume-screen';
export const RELOAD_WINDOW_MS = 10 * 60 * 1000;

const CHUNK_ERROR_PATTERNS = [
  /Importing a module script failed/i,                   // Safari / WebKit
  /Failed to fetch dynamically imported module/i,        // Chrome / Edge
  /error loading dynamically imported module/i,          // Firefox
  /Unable to preload CSS/i,                              // Vite CSS preload
  /Loading (CSS )?chunk [\w-]+ failed/i,                 // webpack-style
  /'text\/html' is not a valid JavaScript MIME type/i,   // HTML served as JS
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: unknown; message?: unknown };
  if (e.name === 'ChunkLoadError') return true;
  const message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  return CHUNK_ERROR_PATTERNS.some((p) => p.test(message));
}

export interface RecoveryDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  reload: () => void;
  now: () => number;
  report: (error: unknown, outcome: RecoveryOutcome) => void;
  currentScreen: () => string | null;
}

export type RecoveryOutcome = 'reloading' | 'already_reloaded' | 'no_storage' | 'not_chunk_error';

function safeStorage(): RecoveryDeps['storage'] {
  try {
    const s = window.sessionStorage;
    const probe = '__vents_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

let screenGetter: () => string | null = () => null;
/** App registers how to read the current screen, so a reload can bring the user back to it. */
export function setRecoveryScreenGetter(getter: () => string | null): void {
  screenGetter = getter;
}

function defaultDeps(): RecoveryDeps {
  return {
    storage: safeStorage(),
    reload: () => window.location.reload(),
    now: () => Date.now(),
    report: (error, outcome) => {
      Sentry.captureException(error, {
        tags: { chunk_load_error: 'true', chunk_recovery: outcome },
        level: outcome === 'reloading' ? 'warning' : 'error',
      });
    },
    currentScreen: () => screenGetter(),
  };
}

/**
 * Handle a failed dynamic import. Reloads the page at most once per tab per
 * RELOAD_WINDOW_MS (the URL, path and query are kept; the in-app screen is
 * restored by consumeResumeScreen). Returns what it did; on anything other
 * than 'reloading' the caller must show the error to the user.
 */
export function recoverFromChunkError(error: unknown, deps: RecoveryDeps = defaultDeps()): RecoveryOutcome {
  if (!isChunkLoadError(error)) return 'not_chunk_error';
  const { storage } = deps;
  if (!storage) {
    // Without storage there is no way to know whether we already reloaded:
    // never risk a loop.
    deps.report(error, 'no_storage');
    return 'no_storage';
  }
  let last = 0;
  try {
    const raw = storage.getItem(RELOAD_MARKER_KEY);
    last = raw ? Number(JSON.parse(raw)?.at) || 0 : 0;
  } catch {
    last = 0;
  }
  const now = deps.now();
  if (last && now - last < RELOAD_WINDOW_MS) {
    deps.report(error, 'already_reloaded');
    return 'already_reloaded';
  }
  try {
    storage.setItem(RELOAD_MARKER_KEY, JSON.stringify({ at: now, build: __VENTS_BUILD_ID__ }));
    const screen = deps.currentScreen();
    if (screen) storage.setItem(RESUME_SCREEN_KEY, screen);
  } catch {
    deps.report(error, 'no_storage');
    return 'no_storage';
  }
  deps.report(error, 'reloading');
  deps.reload();
  return 'reloading';
}

/** The screen to return to after a recovery reload (read once, then cleared). */
export function consumeResumeScreen(storage: RecoveryDeps['storage'] = safeStorage()): string | null {
  if (!storage) return null;
  try {
    const screen = storage.getItem(RESUME_SCREEN_KEY);
    if (screen) storage.removeItem(RESUME_SCREEN_KEY);
    return screen;
  } catch {
    return null;
  }
}

/**
 * React.lazy loader with recovery: a stale chunk triggers the one controlled
 * reload (the promise then never settles, so nothing flashes before the page
 * goes away); otherwise the error is rethrown for the error boundary.
 */
export function lazyImportWithRecovery<T>(load: () => Promise<T>, deps?: RecoveryDeps): () => Promise<T> {
  return () => load().catch((error) => {
    const outcome = recoverFromChunkError(error, deps ?? defaultDeps());
    if (outcome === 'reloading') return new Promise<T>(() => {});
    throw error;
  });
}

let installed = false;
/** Global safety net for dynamic imports not wrapped by lazyImportWithRecovery. */
export function installChunkRecovery(target: Window = window, depsFactory: () => RecoveryDeps = defaultDeps): void {
  if (installed) return;
  installed = true;
  // Vite fires this when a dynamic import's preloaded dependencies fail.
  // preventDefault() only when we are reloading; otherwise Vite rethrows
  // and the caller / error boundary shows the failure.
  target.addEventListener('vite:preloadError', (event: Event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (recoverFromChunkError(payload, depsFactory()) === 'reloading') event.preventDefault();
  });
  // A rejected dynamic import nobody awaited with a catch (Capacitor web
  // plugins, fire-and-forget imports). Sentry still records it.
  target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    if (isChunkLoadError(event.reason)) recoverFromChunkError(event.reason, depsFactory());
  });
}

/** Test hook. */
export function __resetChunkRecoveryForTests(): void {
  installed = false;
  screenGetter = () => null;
}
