import { Capacitor } from '@capacitor/core';

// Shared iOS-native check. Hardened to match shouldUseMapEmbed()'s
// (mapEmbed.ts) own two-part test exactly -- `Capacitor.getPlatform()`
// alone answers "which platform does the bridge say this is," which on
// its own is the right check for a real Capacitor app, but pairing it
// with `isNativePlatform()` is strictly more conservative: it requires
// the native bridge to actually be present, not just a user-agent-shaped
// 'ios' string, closing off any path where this could be satisfied
// outside a genuine native shell. Every iOS-only restriction (the
// Guideline 3.1.1 Paystack removal in AiPlansScreen.tsx, the VENTS AI
// "Coming Soon" gate in App.tsx, and the per-screen self-guards in
// AiAccessScreen.tsx/AiPlansScreen.tsx/VentsAiUnlockedScreen.tsx/
// VentsAiScreen.tsx) reads off this one definition instead of each
// copying its own.
export function isIosNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}
