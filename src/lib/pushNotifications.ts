// ─── Native push notifications (Capacitor + Firebase Cloud Messaging) ─────────
// Replaces the old PushAlert.co CDN <script>, which was ad-blocker-prone and
// didn't work inside the installed app's WebView.
//
// Uses @capacitor-firebase/messaging rather than the plain
// @capacitor/push-notifications plugin. That plugin registers for push
// using each platform's native transport directly — FCM on Android, but
// raw APNs on iOS — and the backend (api/push/send.ts) sends exclusively
// via FCM's v1 API, which cannot deliver to a raw APNs token at all.
// @capacitor-firebase/messaging wraps the Firebase iOS SDK, which
// internally still registers with APNs (required by Apple) but then
// bridges that to a real FCM token via Firebase's servers — so
// getToken() returns an FCM token on BOTH platforms, and the existing
// FCM-only send path works unchanged. Requires GoogleService-Info.plist
// (iOS) / google-services.json (Android) — see IOS_LAUNCH_CHECKLIST.md.
//
// Flow: after login on a native device we ask for permission, fetch the
// FCM token directly (no separate "wait for a registration event" round
// trip — getToken() resolves with it), and POST it to our backend
// (register_push_token RPC) keyed to the user. The server sends to those
// tokens via api/push/send.ts.
//
// On the web this module is a no-op: there is no in-browser transport
// wired up, and the product's push target is the native app.
import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase';
import { trackEvent } from './analytics';
import { askPermission, notifyPermissionDenied } from './permissionPrimer';

const isNative = Capacitor.isNativePlatform();
let registered = false;
// The listeners below are only ever attached once (guarded by `registered`)
// but getToken()/permission requests can run again for a DIFFERENT user on
// the same device — persistToken must always target whoever is currently
// logged in, not the user who happened to be logged in when the listeners
// were first attached. Read via this module-level variable instead of
// closing over a userId parameter.
let currentUserId: string | null = null;

/** Analytics passthrough kept for existing call sites (was PushAlert tracking). */
export function trackPushEvent(eventName: string, properties?: Record<string, string>) {
  trackEvent(eventName, properties);
}

// Event-driven push delivery trigger -- call this immediately after any
// client action whose RPC just inserted a `notifications` row for ANOTHER
// user (ticket-transfer initiate/decline, a service-provider admin
// decision, etc.), so that recipient's push goes out within seconds
// instead of waiting for the once-a-day cron safety-net sweep (Vercel
// Hobby caps cron frequency to daily, so that sweep can never be the
// primary delivery path for a transactional notification). Fire-and-forget
// by design: never awaited by callers for its result, never throws, and a
// missed/failed call is not a regression from before this existed --
// worst case the daily sweep still delivers it eventually, same as always.
export function triggerPushDelivery(userId: string | null | undefined): void {
  if (!userId) return;
  (async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      await fetch('/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deliverForUserId: userId }),
      });
    } catch {
      // Best-effort only -- the daily cron sweep is the safety net.
    }
  })();
}

async function persistToken(userId: string, token: string) {
  try {
    const { error } = await supabase.rpc('register_push_token' as any, {
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
 * Request permission, fetch the FCM token, and sync it for this user.
 * Safe to call on every login — listeners attach once. No-ops on web.
 */
export async function registerPushNotifications(userId: string): Promise<void> {
  if (!isNative || !userId) return;
  currentUserId = userId;

  // Import lazily so the web bundle never pulls native plugin code.
  const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');

  try {
    const perm = await FirebaseMessaging.checkPermissions();
    let receive = perm.receive;
    if (receive === 'prompt' || receive === 'prompt-with-rationale') {
      // Soft pre-ask, shown once per device before the OS prompt — every
      // login re-runs this function, so without the "shown once" gate this
      // would nag on every single login instead of just the first.
      const decision = await askPermission('notifications', {
        icon: 'bell',
        title: 'Stay in the Loop',
        message: 'Get notified about ticket confirmations, event reminders, and new messages.',
      });
      if (decision === 'skip') return;
      receive = (await FirebaseMessaging.requestPermissions()).receive;
    }
    if (receive !== 'granted') {
      console.info('[push] permission not granted:', receive);
      if (receive === 'denied') {
        notifyPermissionDenied({
          icon: 'bell',
          title: 'Notifications Off',
          message: 'You previously denied notifications. Open Settings to turn them back on so you don’t miss ticket and event updates.',
        });
      }
      return;
    }

    if (!registered) {
      registered = true;

      // Fires when the token is (re)issued/rotated by Firebase — the
      // ongoing sync path, distinct from the initial getToken() call below.
      FirebaseMessaging.addListener('tokenReceived', (event) => {
        if (currentUserId && event.token) persistToken(currentUserId, event.token);
      });

      // Foreground receipt — the OS won't show a tray notification while the
      // app is open, so surface it in-app if desired. Left minimal here.
      FirebaseMessaging.addListener('notificationReceived', (event) => {
        trackEvent('push_received', { title: event.notification?.title || '' });
      });

      // User tapped a notification — route to the relevant screen if the
      // payload carries one (data.screen / data.eventId), via a handler
      // App.tsx registers with setPushActionHandler.
      FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
        trackEvent('push_opened', { title: event.notification?.title || '' });
        const data = event.notification?.data as Record<string, any> | undefined;
        if (data && pushActionHandler) pushActionHandler(data);
      });
    }

    // Unlike the old plugin's register() + wait-for-'registration'-event
    // flow, getToken() resolves directly with the current FCM token — no
    // separate listener round trip needed for the initial sync.
    const { token } = await FirebaseMessaging.getToken();
    if (token) await persistToken(userId, token);
  } catch (err) {
    console.warn('[push] setup failed:', err);
  }
}

/** Remove this device's token on logout so it stops receiving pushes. */
export async function unregisterPushNotifications(userId: string): Promise<void> {
  if (!isNative || !userId) return;
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    await FirebaseMessaging.removeAllListeners();
    // deleteToken() also unregisters the device from FCM server-side, not
    // just detaching local listeners — a suspended/logged-out device should
    // stop receiving pushes immediately, not just stop reacting to them.
    try { await FirebaseMessaging.deleteToken(); } catch { /* best-effort */ }
    registered = false;
    currentUserId = null;
    // Best-effort server cleanup; the token itself is device-scoped.
    try { await supabase.rpc('remove_push_tokens_for_user' as any, { p_user_id: userId }); } catch { /* ignore */ }
  } catch { /* ignore */ }
}
