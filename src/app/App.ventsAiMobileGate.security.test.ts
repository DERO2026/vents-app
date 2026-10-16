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
// Update (Apple re-rejection): a "coming soon" screen is no longer
// acceptable on iOS either -- Apple wants VENTS AI to not be visible on
// iOS at all. A second, stricter, iOS-only gate (IS_IOS_NATIVE_FOR_AI,
// isIosNative()) was added on top of the above: it hides the bottom-nav
// tab (BottomNav.tsx), the Home/Services sparkle and "Ask VENTS AI" entry
// points (set to undefined in App.tsx), the Settings toggle
// (SettingsScreen.tsx), and renders nothing at all -- not even
// VentsAiIosComingSoonScreen -- for the 'vents-ai' route. IS_MOBILE_NATIVE_FOR_AI
// and everything it already did are left completely untouched, since
// Android still needs exactly that (the Coming Soon screen covers
// Android's existing Payments Policy restriction) and this fix must not
// change Android or web behavior at all.
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
    expect(src).toMatch(/import\s*\{\s*isIosNative,\s*isMobileNativeForAiGate\s*\}\s*from\s*'\.\.\/lib\/platform'/);
    expect(src).toMatch(/const IS_MOBILE_NATIVE_FOR_AI\s*=\s*isMobileNativeForAiGate\(\)/);
    // The iOS-only helper is a separate, additional constant now (see
    // IS_IOS_NATIVE_FOR_AI below) -- it must not replace this one, since
    // Android still needs the broader isMobileNativeForAiGate() check.
    expect(src).not.toMatch(/const IS_MOBILE_NATIVE_FOR_AI\s*=\s*isIosNative\(\)/);
  });

  it('computes a separate, stricter iOS-only gate via isIosNative()', () => {
    expect(src).toMatch(/const IS_IOS_NATIVE_FOR_AI\s*=\s*isIosNative\(\)/);
  });

  it('the VENTS AI render block renders nothing on iOS, and still branches Android/web on IS_MOBILE_NATIVE_FOR_AI', () => {
    const markerIdx = src.indexOf('{/* ── VENTS AI ── */}');
    expect(markerIdx).toBeGreaterThan(-1);
    const block = src.slice(markerIdx, markerIdx + 4200);

    // iOS is checked first and short-circuits to null -- no Coming Soon,
    // no real flow, nothing.
    const iosIdx = block.indexOf('IS_IOS_NATIVE_FOR_AI ? null :');
    expect(iosIdx).toBeGreaterThan(-1);

    const ifIdx = block.indexOf('IS_MOBILE_NATIVE_FOR_AI ?', iosIdx);
    expect(ifIdx).toBeGreaterThan(iosIdx);

    // The native (Android) branch (before the `) : (` that starts the
    // web-only branch) renders only VentsAiIosComingSoonScreen -- none of
    // the real paywall/chat components. Unchanged from before this fix.
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

  it('does not touch the unrelated Settings > VENTS AI preference toggle wiring, or how BottomNav is invoked', () => {
    // siEnabled is still wired to the user's own Settings preference, not
    // to either mobile-gate flag -- BottomNav.tsx itself (not this prop)
    // is what now hides the tab on iOS, same pattern used everywhere else
    // in this codebase for the component owning the UI to read the
    // platform check directly, rather than the parent conditionally
    // passing a different prop shape.
    expect(src).toMatch(/siEnabled=\{ventsAiEnabled\}/);
    expect(src).not.toMatch(/siEnabled=\{[^}]*IS_MOBILE_NATIVE_FOR_AI/);
    expect(src).not.toMatch(/siEnabled=\{[^}]*IS_IOS_NATIVE_FOR_AI/);
  });

  it('gates every Home/Services/event-details VENTS AI entry point to undefined on iOS', () => {
    const openVentsAiOccurrences = src.match(/onOpenVentsAi=\{IS_IOS_NATIVE_FOR_AI \? undefined : \(\) => seedAndOpenVentsAi\(\)\}/g) ?? [];
    expect(openVentsAiOccurrences.length).toBe(2); // ServicesHomeScreen + HomeScreen
    expect(src).toMatch(/onAskVentsAi=\{IS_IOS_NATIVE_FOR_AI \? undefined : openVentsAiForEvent\}/);
  });
});
