import { Capacitor } from '@capacitor/core';

// Hides the native launch splash (drawable/splash.png) once the JS splash
// (SplashScreen.tsx) has painted its first frame — both use the exact same
// #020005 background/logo, so the handoff between them is invisible instead
// of showing a blank white/black flash while the JS bundle was loading.
// No-ops on web.
export async function hideNativeSplash(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch { /* best-effort */ }
}

// Themes the native status bar to match the app's own background instead of
// leaving the OS default (often a mismatched light/white bar) sitting above
// a dark app. Re-applied on every theme toggle, not just at startup.
export async function applyNativeStatusBar(isDark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: isDark ? '#020005' : '#F5F3FA' });
  } catch { /* not supported on this platform/version — safe to ignore */ }
}
