// Where a URL that opened the native app should take the user.
//
// iOS Universal Links / Android App Links (https://getvents.com/?…) and the
// vents:// scheme reach the app through @capacitor/app's appUrlOpen event,
// both on a cold start (the plugin retains the event until the listener is
// registered) and while the app is already open. App.tsx's own URL parsing
// only reads window.location on a web page load, which a Capacitor WebView
// never has, so every native link goes through this one function.
//
// Only links from VENTS itself are honoured: https://getvents.com (or www.)
// and vents://. Anything else resolves to { kind: 'none' }.
//
// Referral links (?ref=, ?rep=) are deliberately NOT app links: they attribute
// sign-ups and are meant to open the website for people without the app.
//
// Payment links (?pay=<username>, from the wallet's Receive sheet) carry only
// a public username: no amount, no wallet data. They only ever OPEN the Send
// Money sheet with the recipient looked up; the sender still confirms the
// recipient, amount and PIN, and the server authorises every transfer. An
// invalid username resolves to { kind: 'invalid_pay' } so the app can say so
// instead of silently doing nothing (or worse, guessing).

import { PAY_PARAM, usernameFromPayParam } from './walletTransfers';

export type OpenedUrlRoute =
  | { kind: 'verify_email'; email: string }
  | { kind: 'reset_password'; email: string }
  | { kind: 'payment_return'; ref: string }
  | { kind: 'pay'; username: string }
  | { kind: 'invalid_pay' }
  | { kind: 'payment_request'; paymentRef: string }
  | { kind: 'event'; eventId: string; screen?: string }
  | { kind: 'user'; userId: string; screen?: string }
  | { kind: 'provider'; providerId: string }
  | { kind: 'screen'; screen: string }
  | { kind: 'none' };

const VENTS_HOSTS = new Set(['getvents.com', 'www.getvents.com']);

// Ids are database UUIDs; anything else cannot name a real row.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "Someone else is paying" refs: 'VNT-' + 32 hex (0058_ticket_payment_requests.sql).
const PAYMENT_REF_RE = /^VNT-[0-9a-f]{32}$/i;
const clean = (v: string | null) => (v ?? '').trim();

export function routeOpenedUrl(raw: string | null | undefined): OpenedUrlRoute {
  if (!raw) return { kind: 'none' };
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: 'none' }; }

  const isScheme = url.protocol === 'vents:';
  const isWeb = url.protocol === 'https:' && VENTS_HOSTS.has(url.hostname.toLowerCase());
  if (!isScheme && !isWeb) return { kind: 'none' };
  const q = url.searchParams;

  // vents:// round trips started by emails and by Paystack's redirect.
  if (isScheme) {
    const host = url.hostname.toLowerCase();
    if (host === 'verify') return clean(q.get('email')) ? { kind: 'verify_email', email: clean(q.get('email')) } : { kind: 'none' };
    if (host === 'reset') return clean(q.get('email')) ? { kind: 'reset_password', email: clean(q.get('email')) } : { kind: 'none' };
    if (host === 'payment') return clean(q.get('ref')) ? { kind: 'payment_return', ref: clean(q.get('ref')) } : { kind: 'none' };
  }

  // A payment link wins over any other parameter it may carry (e.g. utm_*).
  if (q.has(PAY_PARAM)) {
    const username = usernameFromPayParam(q.get(PAY_PARAM));
    return username ? { kind: 'pay', username } : { kind: 'invalid_pay' };
  }

  // ?payment_request=<ref>: opens PaymentRequestScreen, which loads the request
  // itself (payer or recipient only, RLS-backed). Nothing is paid from a link.
  const paymentRequest = clean(q.get('payment_request'));
  if (paymentRequest) return PAYMENT_REF_RE.test(paymentRequest) ? { kind: 'payment_request', paymentRef: paymentRequest } : { kind: 'none' };

  const screen = clean(q.get('screen')) || undefined;
  const eventId = clean(q.get('event'));
  if (eventId) return UUID_RE.test(eventId) ? { kind: 'event', eventId, screen } : { kind: 'none' };
  const userId = clean(q.get('user'));
  if (userId) return UUID_RE.test(userId) ? { kind: 'user', userId, screen } : { kind: 'none' };
  const providerId = clean(q.get('provider'));
  if (providerId) return UUID_RE.test(providerId) ? { kind: 'provider', providerId } : { kind: 'none' };
  if (screen) return { kind: 'screen', screen };
  return { kind: 'none' };
}
