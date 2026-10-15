import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Interim fix (not real Apple In-App Purchase / Google Play Billing):
// VENTS AI is temporarily unavailable on native iOS AND Android (the
// Android restriction added in Phase 2 of the Oct 2026 Android
// release-readiness audit, mirroring the original iOS fix -- Google
// Play's Payments Policy treats Paystack-sold digital subscription
// content the same way Apple's Guideline 3.1.1 does). Every entry point
// into VENTS AI (the bottom-nav tab, the Home/Services sparkle, "Ask
// VENTS AI to plan this night" on event details) funnels through the
// single `navigateTo('vents-ai')` call and the one `screen === 'vents-ai'`
// render block in App.tsx -- so gating that one block, rather than each
// call site individually, is what makes the restriction apply
// consistently on both native platforms. Confirmed before this change:
// those four components (AiAccessScreen, AiPlansScreen,
// VentsAiUnlockedScreen, VentsAiScreen, which has its own internal
// AiPlansScreen too) are mounted nowhere else in App.tsx.
//
// No React-render test harness exists for App.tsx (3700+ lines, huge
// dependency graph) in this codebase, so this locks in the gate
// statically, same convention as App.deepLinkUrlPreservation.security.test.ts.

let src: string;

beforeAll(() => {
  src = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
});

describe('VENTS AI mobile gate: real paywall/chat flow is replaced wholesale on iOS AND Android', () => {
  it('computes the mobile-native check via the shared platform helper (same one AiPlansScreen.tsx uses)', () => {
    expect(src).toMatch(/import\s*\{\s*isMobileNativeForAiGate\s*\}\s*from\s*'\.\.\/lib\/platform'/);
    expect(src).toMatch(/const IS_MOBILE_NATIVE_FOR_AI\s*=\s*isMobileNativeForAiGate\(\)/);
    // The old iOS-only helper must not be what this gate reads off anymore.
    expect(src).not.toMatch(/const IS_MOBILE_NATIVE_FOR_AI\s*=\s*isIosNative\(\)/);
  });

  it('the VENTS AI render block branches on IS_MOBILE_NATIVE_FOR_AI', () => {
    const markerIdx = src.indexOf('{/* ── VENTS AI ── */}');
    expect(markerIdx).toBeGreaterThan(-1);
    const block = src.slice(markerIdx, markerIdx + 4000);
    const ifIdx = block.indexOf('IS_MOBILE_NATIVE_FOR_AI ?');
    expect(ifIdx).toBeGreaterThan(-1);

    // The native branch (before the `) : (` that starts the web-only
    // branch) renders only VentsAiIosComingSoonScreen -- none of the real
    // paywall/chat components.
    const elseIdx = block.indexOf(') : (', ifIdx);
    expect(elseIdx).toBeGreaterThan(ifIdx);
    const nativeBranch = block.slice(ifIdx, elseIdx);
    expect(nativeBranch).toContain('VentsAiIosComingSoonScreen');
    expect(nativeBranch).not.toContain('<AiAccessScreen');
    expect(nativeBranch).not.toContain('<AiPlansScreen');
    expect(nativeBranch).not.toContain('<VentsAiUnlockedScreen');
    expect(nativeBranch).not.toContain('<VentsAiScreen');

    // The web-only branch renders the real flow, completely unchanged
    // from before this fix.
    const webBranch = block.slice(elseIdx);
    expect(webBranch).toContain('<AiAccessScreen');
    expect(webBranch).toContain('<AiPlansScreen');
    expect(webBranch).toContain('<VentsAiUnlockedScreen');
    expect(webBranch).toContain('<VentsAiScreen');
  });

  it('VentsAiIosComingSoonScreen is only ever rendered (as JSX) inside the native branch, nowhere else in App.tsx', () => {
    const jsxOccurrences = src.split('<VentsAiIosComingSoonScreen').length - 1;
    expect(jsxOccurrences).toBe(1);
  });

  it('every real VENTS AI entry point still funnels through the one navigateTo(\'vents-ai\') call, unchanged', () => {
    expect(src).toContain("navigateTo('vents-ai')");
    expect(src).toMatch(/seedAndOpenVentsAi[\s\S]{0,120}navigateTo\('vents-ai'\)/);
    expect(src).toMatch(/onOpenSi=\{\(\)\s*=>\s*navigateTo\('vents-ai'\)\}/);
  });

  it('does not disable the VENTS AI bottom-nav tab or touch the unrelated Settings > VENTS AI preference toggle', () => {
    // siEnabled is still wired to the user's own Settings preference, not
    // to the new mobile-gate flag -- the tab stays visible/tappable on
    // iOS/Android per the interim product requirement ("keep the tab
    // visible, tapping it opens Coming Soon"), it just renders a different
    // screen once tapped.
    expect(src).toMatch(/siEnabled=\{ventsAiEnabled\}/);
    expect(src).not.toMatch(/siEnabled=\{[^}]*IS_MOBILE_NATIVE_FOR_AI/);
  });
});
