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

// Same two-part shape as isIosNative() above, for the Android side of the
// same question. VENTS AI/AI+ sell digital, in-app-consumed subscription
// access via Paystack -- a non-Apple, non-Google payment mechanism -- which
// Google Play's Payments Policy treats the same way Apple's Guideline 3.1.1
// does: digital content consumed inside the app must go through the
// platform's own billing (Play Billing here), not a third-party processor.
// Google Play Billing is not implemented, so until it is, VENTS AI/AI+
// purchases are restricted on Android the same way they already are on
// iOS -- see isMobileNativeForAiGate() below for the combined check the
// AI screens actually use.
export function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

// The actual check every VENTS AI self-guard uses (AiAccessScreen.tsx,
// AiPlansScreen.tsx, VentsAiUnlockedScreen.tsx, VentsAiScreen.tsx,
// App.tsx's IS_IOS_NATIVE_FOR_AI). Kept as one named export, rather than
// each call site writing `isIosNative() || isAndroidNative()` itself, so
// the "which platforms restrict AI purchases" decision lives in exactly
// one place -- unchanged for iOS, newly true for Android, still false on
// web, where Paystack subscription purchasing must keep working exactly
// as before.
export function isMobileNativeForAiGate(): boolean {
  return isIosNative() || isAndroidNative();
}
