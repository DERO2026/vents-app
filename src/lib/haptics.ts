import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

// Thin wrapper so every tap/toggle/success moment across the app calls one
// place — native builds get real Taptic/vibration feedback via Capacitor;
// web (including the dev preview here) silently no-ops since there's no
// native haptic engine to call into, rather than every call site needing
// its own Capacitor.isNativePlatform() guard.
const isNative = () => Capacitor.isNativePlatform();

export const haptics = {
  /** Light tap — button presses, toggles, ticket qty +/-. */
  light: () => { if (isNative()) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); },
  /** Medium tap — selecting a ticket tier, opening a sheet. */
  medium: () => { if (isNative()) Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); },
  /** Heavier tap — primary CTA confirmations (book, publish, pay). */
  heavy: () => { if (isNative()) Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {}); },
  /** Success buzz — purchase complete, event published. */
  success: () => { if (isNative()) Haptics.notification({ type: NotificationType.Success }).catch(() => {}); },
  /** Error buzz — failed payment, validation error. */
  error: () => { if (isNative()) Haptics.notification({ type: NotificationType.Error }).catch(() => {}); },
};
