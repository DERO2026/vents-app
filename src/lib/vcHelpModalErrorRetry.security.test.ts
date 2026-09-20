import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static source-assertion tests for VENTS Cents Batch F3 -- VcHelpModal.tsx
// error/retry polish. F2's own review flagged that a get_vc_config() fetch
// failure left the modal stuck forever on "Loading VENTS Cents info…" with
// no error/retry UI. Mirrors this repo's own convention (see
// vcF2UserExperience.security.test.ts) of asserting against the actual
// shipped source rather than a re-implementation that could silently drift.

let helpModalSrc: string;

beforeAll(() => {
  const componentsDir = join(__dirname, '..', 'app', 'components');
  helpModalSrc = readFileSync(join(componentsDir, 'VcHelpModal.tsx'), 'utf8');
});

describe('VcHelpModal.tsx useVcConfig hook exposes loading/config/error/retry', () => {
  it('declares an explicit error state alongside loading and config', () => {
    expect(helpModalSrc).toMatch(/const \[error, setError\] = useState<string \| null>\(null\)/);
  });

  it('on fetch failure, sets loading=false and the error state, and leaves config null', () => {
    expect(helpModalSrc).toMatch(/setConfig\(null\);\s*\n\s*setError\(/);
  });

  it('returns config, loading, error and retry from useVcConfig', () => {
    expect(helpModalSrc).toMatch(/return \{ config, loading, error, retry: load \};/);
  });
});

describe('VcHelpModal.tsx renders a distinct, VENTS-native error/retry UI', () => {
  it('renders a distinct error message when error is set, not the loading message', () => {
    expect(helpModalSrc).toMatch(/error \?[\s\S]{0,400}Couldn&apos;t load VENTS Cents info right now/);
  });

  it('still renders the regular "Loading…" message for the plain loading case (regression)', () => {
    expect(helpModalSrc).toMatch(/Loading VENTS Cents info…/);
  });

  it('uses the shared ventsColors design tokens in the error UI, not a generic hardcoded red error box', () => {
    const errorBlockMatch = helpModalSrc.match(/error \?([\s\S]*?)\) : loading \|\| !config \?/);
    expect(errorBlockMatch).toBeTruthy();
    const errorBlock = errorBlockMatch![1];
    expect(errorBlock).toMatch(/ventsColors\./);
  });

  it('has a Retry button that calls the real retry/load function', () => {
    expect(helpModalSrc).toMatch(/onClick=\{retry\}/);
  });

  it('the successful-load render path (tabs) is unchanged and still gated on config', () => {
    expect(helpModalSrc).toMatch(/tab === 'overview' && <OverviewTab config=\{config\} \/>/);
    expect(helpModalSrc).toMatch(/tab === 'earn' && <EarnTab config=\{config\} \/>/);
    expect(helpModalSrc).toMatch(/tab === 'spend' && <SpendTab config=\{config\} \/>/);
    expect(helpModalSrc).toMatch(/tab === 'cashout' && <CashoutTab config=\{config\} \/>/);
  });
});

describe('VcHelpModal.tsx retry guards against duplicate/concurrent requests', () => {
  it('the load function guards against firing a second request while one is already in-flight', () => {
    expect(helpModalSrc).toMatch(/if \(inFlightRef\.current\) return;/);
  });

  it('the Retry button is disabled while a retry/load is in-flight (loading)', () => {
    expect(helpModalSrc).toMatch(/onClick=\{retry\}\s*\n\s*disabled=\{loading\}/);
  });
});

describe('VcHelpModal.tsx error/retry path never hardcodes a VC economy number', () => {
  it('the error-state render block contains no bare VC economy number literals', () => {
    const errorBlockMatch = helpModalSrc.match(/error \?([\s\S]*?)\) : loading \|\| !config \?/);
    expect(errorBlockMatch).toBeTruthy();
    const errorBlock = errorBlockMatch![1];
    // None of the known VC economy literals (earn amounts, badge prices,
    // cash-out rate/limits) should ever appear standing in for real config
    // in the error/retry UI -- it must show the error state, never a
    // stale/guessed number.
    const forbiddenNumbers = ['100', '150', '300', '50', '300', '800', '2000', '5000', '12000', '25000', '25,000', '1,000'];
    for (const n of forbiddenNumbers) {
      expect(errorBlock).not.toContain(n);
    }
  });

  it('the load()/retry function itself never falls back to a hardcoded config value on error', () => {
    // On error, config is explicitly set to null (never populated with a
    // guessed/default object) and no fallback VcConfig literal is assigned.
    expect(helpModalSrc).toMatch(/catch \(err\) \{\s*\n\s*console\.error\('Failed to load VC config:', err\);\s*\n\s*Sentry\.captureException\(err\);\s*\n\s*setConfig\(null\);/);
  });
});
