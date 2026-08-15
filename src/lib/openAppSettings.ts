import { Capacitor } from '@capacitor/core';

// Deep-links straight to this app's OS settings page (where camera/notification
// toggles actually live) instead of leaving a user who denied a permission with
// no path back except uninstalling and reinstalling. No-op on web — there's no
// equivalent settings page to send a browser tab to.
export async function openAppSettings(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { NativeSettings, AndroidSettings, IOSSettings } = await import('capacitor-native-settings');
    await NativeSettings.open({
      optionAndroid: AndroidSettings.ApplicationDetails,
      optionIOS: IOSSettings.App,
    });
  } catch (err) {
    console.warn('[settings] failed to open app settings:', err);
  }
}
