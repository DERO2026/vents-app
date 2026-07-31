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
// The 'registration' listener is only ever attached once (guarded by
// `registered` below) but can fire again on a later call to
// PushNotifications.register() for a DIFFERENT user on the same device —
// it must always persist the token against whoever is currently logged in,
// not the user who happened to be logged in when the listener was first
// attached. Read via this module-level variable instead of closing over
// the userId parameter.
let currentUserId: string | null = null;

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

// Set by App.tsx so a tapped notification can navigate — kept outside React
// state since this fires from a native plugin listener, not a component.
let pushActionHandler: ((data: Record<string, any>) => void) | null = null;
export function setPushActionHandler(handler: ((data: Record<string, any>) => void) | null) {
  pushActionHandler = handler;
}

/**
 * Request permission, register with FCM, and sync the device token for this
 * user. Safe to call on every login — listeners attach once. No-ops on web.
 */
export async function registerPushNotifications(userId: string): Promise<void> {
  if (!isNative || !userId) return;
  currentUserId = userId;

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
        // Always the user currently logged in on this device, not whoever
        // was logged in when this listener was first attached.
        if (currentUserId) persistToken(currentUserId, token.value);
      });

      PushNotifications.addListener('registrationError', (err) => {
        console.warn('[push] registration error:', err);
      });

      // Foreground receipt — the OS won't show a tray notification while the
      // app is open, so surface it in-app if desired. Left minimal here.
      PushNotifications.addListener('pushNotificationReceived', (notif) => {
        trackEvent('push_received', { title: notif.title || '' });
      });

      // User tapped a notification — route to the relevant screen if the
      // payload carries one (data.screen / data.eventId), via a handler
      // App.tsx registers with setPushActionHandler. Previously this only
      // fired an analytics event, so every push was a dead end that opened
      // the home screen.
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        trackEvent('push_opened', { title: action.notification.title || '' });
        const data = action.notification.data as Record<string, any> | undefined;
        if (data && pushActionHandler) pushActionHandler(data);
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
    currentUserId = null;
    // Best-effort server cleanup; the token itself is device-scoped.
    try { await insforge.database.rpc('remove_push_tokens_for_user' as any, { p_user_id: userId }); } catch { /* ignore */ }
  } catch { /* ignore */ }
}
