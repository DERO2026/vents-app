import { Capacitor } from '@capacitor/core';

// Shared iOS-native check -- same `Capacitor.getPlatform()` test
// `shouldUseMapEmbed()` (mapEmbed.ts) already uses, pulled out here so
// every iOS-only restriction (the Guideline 3.1.1 Paystack removal in
// AiPlansScreen.tsx, and the VENTS AI "Coming Soon" gate in App.tsx) reads
// off one definition instead of each copying its own.
export function isIosNative(): boolean {
  return Capacitor.getPlatform() === 'ios';
}
