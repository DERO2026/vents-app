// ─── Native push notifications (Capacitor + Firebase Cloud Messaging) ─────────
// Replaces the old PushAlert.co CDN <script>, which was ad-blocker-prone and
// didn't work inside the installed app's WebView. This uses the official
// @capacitor/push-notifications plugin, backed by FCM on Android.
//
// Flow: after login on a native device we ask for permission, register with
// FCM, and POST the returned device token to our backend (register_push_token
// RPC) keyed to the user. The server sends to those tokens via api/push/send.
//
// On the web this module is a no-op: the plugin has no browser transport, and
// the product's push target is the native app (see the platform decision).
// Web push (VAPID) can be added later as a separate transport without touching
// call sites.
import { Capacitor } from '@capacitor/core';
import { insforge } from './insforge';
import { trackEvent } from './analytics';

const isNative = Capacitor.isNativePlatform();
let registered = false;

/** Analytics passthrough kept for existing call sites (was PushAlert tracking). */
export function trackPushEvent(eventName: string, properties?: Record<string, string>) {
  trackEvent(eventName, properties);
}

async function persistToken(userId: string, token: string) {
  try {
    const { error } = await insforge.database.rpc('register_push_token' as any, {
      p_user_id: userId,
      p_token: token,
      p_platform: Capacitor.getPlatform(), // 'android' | 'ios'
    });
    if (error) console.warn('[push] token registration failed:', error);
  } catch (err) {
    console.warn('[push] token registration threw:', err);
  }
}

/**
 * Request permission, register with FCM, and sync the device token for this
 * user. Safe to call on every login — listeners attach once. No-ops on web.
 */
export async function registerPushNotifications(userId: string): Promise<void> {
  if (!isNative || !userId) return;

  // Import lazily so the web bundle never pulls native plugin code.
  const { PushNotifications } = await import('@capacitor/push-notifications');

  try {
    const perm = await PushNotifications.checkPermissions();
    let receive = perm.receive;
    if (receive === 'prompt' || receive === 'prompt-with-rationale') {
      receive = (await PushNotifications.requestPermissions()).receive;
    }
    if (receive !== 'granted') {
      console.info('[push] permission not granted:', receive);
      return;
    }

    if (!registered) {
      registered = true;

      PushNotifications.addListener('registration', (token) => {
        persistToken(userId, token.value);
      });

      PushNotifications.addListener('registrationError', (err) => {
        console.warn('[push] registration error:', err);
      });

      // Foreground receipt — the OS won't show a tray notification while the
      // app is open, so surface it in-app if desired. Left minimal here.
      PushNotifications.addListener('pushNotificationReceived', (notif) => {
        trackEvent('push_received', { title: notif.title || '' });
      });

      // User tapped a notification — route deep links here if the payload
      // carries one (data.screen / data.eventId).
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        trackEvent('push_opened', { title: action.notification.title || '' });
      });
    }

    await PushNotifications.register();
  } catch (err) {
    console.warn('[push] setup failed:', err);
  }
}

/** Remove this device's token on logout so it stops receiving pushes. */
export async function unregisterPushNotifications(userId: string): Promise<void> {
  if (!isNative || !userId) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllListeners();
    registered = false;
    // Best-effort server cleanup; the token itself is device-scoped.
    try { await insforge.database.rpc('remove_push_tokens_for_user' as any, { p_user_id: userId }); } catch { /* ignore */ }
  } catch { /* ignore */ }
}
