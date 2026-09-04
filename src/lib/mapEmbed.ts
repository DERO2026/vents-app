import { Capacitor } from '@capacitor/core';

// iOS-only workaround for the gm_authFailure problem documented in
// googleMaps.ts: a Capacitor WKWebView's origin is permanently
// `capacitor://localhost` (confirmed against @capacitor/ios's actual native
// source — CAPInstanceDescriptor.swift rejects any `server.iosScheme`
// override that collides with a scheme WKWebView already handles, silently
// falling back to `capacitor`), so there is no config flag that makes iOS
// present as an HTTPS origin the way `androidScheme: 'https'` does for
// Android. Instead of adding capacitor://localhost to the Google Maps API
// key's HTTP referrer allowlist (skipped per explicit instruction — Google's
// own docs describe custom-scheme referrer matching as unreliable), the map
// itself is rendered inside a real `<iframe src="https://getvents.com/embed/
// map.html">`. That iframe performs a genuine HTTPS navigation, so the Maps
// JS API script it loads carries a real `https://getvents.com/...` Referer
// header -- covered by the same referrer allowlist entry the ordinary web
// app (browser users) already relies on. Android and web are completely
// untouched: they keep calling loadGoogleMaps() directly, exactly as before.
export function shouldUseMapEmbed(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

// Hardcoded to the real production origin -- never derived from
// window.location or any other runtime value, so this can't be redirected
// to an attacker-controlled host. The embed page only exists at this one
// deployed location.
export const MAP_EMBED_ORIGIN = 'https://getvents.com';

// The Capacitor iOS WebView's origin is a fixed platform constant, not
// something read from the environment -- same reasoning as MAP_EMBED_ORIGIN
// above. Used to validate inbound postMessage origin on the *embed page*
// side (see embed/map.html) and as the explicit postMessage targetOrigin
// when the app sends commands *into* the iframe.
export const CAPACITOR_APP_ORIGIN = 'capacitor://localhost';

export type MapEmbedMode = 'display' | 'picker';

export interface MapEmbedInitParams {
  mode: MapEmbedMode;
  lat?: number | null;
  lng?: number | null;
  venue?: string;
  address?: string;
}

// Only ever carries non-secret data already visible elsewhere in the app UI
// (coordinates, venue/address strings) -- never the Maps API key, which
// lives solely in embed/map.html's own build-time-injected script tag and
// is never transmitted via postMessage or URL in either direction.
export function buildMapEmbedUrl({ mode, lat, lng, venue, address }: MapEmbedInitParams): string {
  const params = new URLSearchParams({ mode });
  if (lat != null && lng != null) {
    params.set('lat', String(lat));
    params.set('lng', String(lng));
  }
  if (venue) params.set('venue', venue);
  if (address) params.set('address', address);
  return `${MAP_EMBED_ORIGIN}/embed/map.html?${params.toString()}`;
}

// Every message type the embed page can send back to the app. Kept as a
// discriminated union so each listener switches exhaustively rather than
// trusting arbitrary shapes from postMessage data.
export type MapEmbedOutMessage =
  | { type: 'vents:ready' }
  | { type: 'vents:authFailure' }
  | { type: 'vents:error'; message: string }
  | { type: 'vents:locationChanged'; lat: number; lng: number; address: string; city: string; state: string; country: string }
  | { type: 'vents:suggestions'; requestId: number; suggestions: { index: number; mainText: string; secondaryText: string }[] }
  | { type: 'vents:placeSelected'; lat: number | null; lng: number | null; address: string; venue: string; city: string; state: string; country: string; placeId: string };

// Every message type the app can send into the embed page. `requestId` on
// search is echoed back verbatim on the matching `vents:suggestions`
// response, so the caller can discard a stale reply the same way
// LocationPicker's own requestSeqRef already discards stale direct-API
// results — necessary because postMessage delivery order isn't guaranteed
// to match a slower-then-faster pair of debounced searches.
export type MapEmbedInMessage =
  | { type: 'vents:search'; query: string; requestId: number }
  | { type: 'vents:select'; index: number };

function isMapEmbedOutMessage(data: unknown): data is MapEmbedOutMessage {
  return !!data && typeof data === 'object' && typeof (data as any).type === 'string' && (data as any).type.startsWith('vents:');
}

// Registers a single, origin-validated `message` listener scoped to one
// iframe element. Rejects any event whose `origin` isn't exactly the real
// embed page's origin -- postMessage delivers to every listener on the page
// regardless of sender, so this check is the only thing standing between
// "trusted embed page" and "any other frame/extension that happens to call
// postMessage on this window." Returns an unsubscribe function.
export function listenToMapEmbed(onMessage: (msg: MapEmbedOutMessage) => void): () => void {
  const handler = (event: MessageEvent) => {
    if (event.origin !== MAP_EMBED_ORIGIN) return;
    if (!isMapEmbedOutMessage(event.data)) return;
    onMessage(event.data);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

// Posts a command into the iframe with an explicit targetOrigin (never '*')
// so the browser refuses delivery if the iframe has somehow navigated away
// from the real embed origin.
export function postToMapEmbed(iframe: HTMLIFrameElement | null, message: MapEmbedInMessage): void {
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage(message, MAP_EMBED_ORIGIN);
}
