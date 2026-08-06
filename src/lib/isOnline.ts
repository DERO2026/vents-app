import { Capacitor } from '@capacitor/core';

// navigator.onLine is known to be unreliable inside Android WebViews — it can
// report true even with no real connectivity (it only reflects whether the
// device has a network interface at all, not whether it can reach the
// internet). @capacitor/network's Network.getStatus() queries the OS's
// actual connectivity state instead. Falls back to navigator.onLine on web,
// where there's no native equivalent.
export async function isOnline(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Network } = await import('@capacitor/network');
      const status = await Network.getStatus();
      return status.connected;
    } catch {
      return navigator.onLine;
    }
  }
  return navigator.onLine;
}
