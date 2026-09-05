import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the Sentry Replay quota fix. Root cause: Sentry
// reported "Replays are being dropped -- 100% of replay budget consumed".
// replaysSessionSampleRate was 0.1 -- a full-session replay recorded for
// 10% of EVERY session, in every environment (dev/Preview/production
// alike), regardless of whether anything went wrong. That's the most
// storage-expensive thing Sentry captures, spent on sessions with no
// diagnostic need for a full recording. Fixed by dropping baseline
// session-based replay to 0 everywhere, and gating both tracing and
// error-triggered replay to run only in production (still 1.0 there, since
// that's the actually valuable, comparatively cheap case: a replay
// guaranteed for every session that errors).

let sentrySrc: string;

beforeAll(() => {
  sentrySrc = readFileSync(join(__dirname, 'sentry.ts'), 'utf8');
});

describe('Sentry Replay quota fix (src/lib/sentry.ts)', () => {
  it('baseline session replay sampling is disabled everywhere -- the actual quota drain', () => {
    expect(sentrySrc).toMatch(/replaysSessionSampleRate: 0,/);
  });

  it('error-triggered replay stays fully enabled in production (the valuable, cheap case)', () => {
    expect(sentrySrc).toMatch(/replaysOnErrorSampleRate: IS_PRODUCTION \? 1\.0 : 0,/);
  });

  it('replay/tracing sampling is gated to production so Preview/dev QA never spends the shared quota', () => {
    expect(sentrySrc).toMatch(/const IS_PRODUCTION = \(import\.meta\.env\.MODE \|\| 'production'\) === 'production';/);
    expect(sentrySrc).toMatch(/tracesSampleRate: IS_PRODUCTION \? 0\.1 : 0,/);
  });

  it('error reporting itself is never disabled -- Sentry.init and the replay integration still run in every environment', () => {
    expect(sentrySrc).toMatch(/Sentry\.init\(\{/);
    expect(sentrySrc).toMatch(/Sentry\.replayIntegration\(\{/);
  });

  it('Replay privacy defaults (mask text, block media) are unchanged', () => {
    expect(sentrySrc).toMatch(/maskAllText: true,/);
    expect(sentrySrc).toMatch(/blockAllMedia: true,/);
  });
});
