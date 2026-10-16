import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS AI is web-only for this release: not a disabled tab, not a
// "Coming Soon" screen -- fully absent from both native mobile apps.
// Every entry point into VENTS AI (the bottom-nav tab, the Home/Services
// sparkle, "Ask VENTS AI to plan this night" on event details, the
// Settings toggle) is gated to undefined/hidden on mobile, and the
// `screen === 'vents-ai'` render block itself renders nothing on mobile
// -- covering any stale deep link that could still set that screen state.
// isMobileNativeForAiGate() (src/lib/platform.ts) is the single source of
// truth for "is this iOS or Android native," reused everywhere here so
// the web-only decision lives in one place.
//
// This started as an iOS-only "coming soon" interim fix (Guideline 3.1.1),
// was widened to also gate Android purchases (Google Play Payments
// Policy), then an iOS-only "remove the coming soon screen too" fix, and
// is now widened one more time to cover Android the same way -- VENTS AI
// is web-only, full stop, until a future release decides otherwise.
//
// No React-render test harness exists for App.tsx (3700+ lines, huge
// dependency graph) in this codebase, so this locks in the gate
// statically, same convention as App.deepLinkUrlPreservation.security.test.ts.

let src: string;

beforeAll(() => {
  src = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
});

describe('VENTS AI mobile gate: real paywall/chat flow (and any placeholder) is absent on iOS AND Android', () => {
  it('computes the mobile-native check via the shared platform helper (same one AiPlansScreen.tsx uses)', () => {
    expect(src).toMatch(/import\s*\{\s*isMobileNativeForAiGate\s*\}\s*from\s*'\.\.\/lib\/platform'/);
    expect(src).toMatch(/const IS_MOBILE_NATIVE_FOR_AI\s*=\s*isMobileNativeForAiGate\(\)/);
  });

  it('does not import or render VentsAiIosComingSoonScreen anywhere in App.tsx (comments may still mention it historically)', () => {
    expect(src).not.toMatch(/import\s*\{\s*VentsAiIosComingSoonScreen\s*\}/);
    expect(src).not.toMatch(/<VentsAiIosComingSoonScreen/);
  });

  it('the VENTS AI render block renders nothing on mobile (iOS or Android), the real flow only on web', () => {
    const markerIdx = src.indexOf('{/* ── VENTS AI ── */}');
    expect(markerIdx).toBeGreaterThan(-1);
    const block = src.slice(markerIdx, markerIdx + 4200);

    const ifIdx = block.indexOf('IS_MOBILE_NATIVE_FOR_AI ? null : (');
    expect(ifIdx).toBeGreaterThan(-1);

    const webBranch = block.slice(ifIdx);
    expect(webBranch).toContain('<AiAccessScreen');
    expect(webBranch).toContain('<AiPlansScreen');
    expect(webBranch).toContain('<VentsAiUnlockedScreen');
    expect(webBranch).toContain('<VentsAiScreen');
  });

  it('every real VENTS AI entry point still funnels through the one navigateTo(\'vents-ai\') call, unchanged', () => {
    expect(src).toContain("navigateTo('vents-ai')");
    expect(src).toMatch(/seedAndOpenVentsAi[\s\S]{0,120}navigateTo\('vents-ai'\)/);
    expect(src).toMatch(/onOpenSi=\{\(\)\s*=>\s*navigateTo\('vents-ai'\)\}/);
  });

  it('does not touch the unrelated Settings > VENTS AI preference toggle wiring, or how BottomNav is invoked', () => {
    // siEnabled is still wired to the user's own Settings preference, not
    // to the mobile-gate flag -- BottomNav.tsx itself (not this prop) is
    // what hides the tab on mobile, same pattern used everywhere else in
    // this codebase for the component owning the UI to read the platform
    // check directly, rather than the parent conditionally passing a
    // different prop shape.
    expect(src).toMatch(/siEnabled=\{ventsAiEnabled\}/);
    expect(src).not.toMatch(/siEnabled=\{[^}]*IS_MOBILE_NATIVE_FOR_AI/);
  });

  it('gates every Home/Services/event-details VENTS AI entry point to undefined on mobile', () => {
    const openVentsAiOccurrences = src.match(/onOpenVentsAi=\{IS_MOBILE_NATIVE_FOR_AI \? undefined : \(\) => seedAndOpenVentsAi\(\)\}/g) ?? [];
    expect(openVentsAiOccurrences.length).toBe(2); // ServicesHomeScreen + HomeScreen
    expect(src).toMatch(/onAskVentsAi=\{IS_MOBILE_NATIVE_FOR_AI \? undefined : openVentsAiForEvent\}/);
  });
});
