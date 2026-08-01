import { Capacitor } from '@capacitor/core';

// window.open()/target="_blank" either no-ops or replaces the entire app
// view with no way back inside a Capacitor WKWebView — there's no browser
// chrome, no tabs, no back button. @capacitor/browser's Browser.open()
// presents a proper in-app Safari View Controller (iOS) / Custom Tab
// (Android) with its own close button instead. mailto:/tel: links are
// handled by the OS regardless of platform via a plain location change.
export async function openExternalUrl(url: string): Promise<void> {
  // Non-http(s) schemes (mailto:, tel:, maps://, geo:, wa.me deep links via
  // a native app, etc.) are handled by the OS itself — WKWebView already
  // delegates an unrecognized scheme to the right native app on a location
  // change. Browser.open() only understands http(s) and would fail on these.
  if (!/^https?:/i.test(url)) {
    window.location.href = url;
    return;
  }
  if (Capacitor.isNativePlatform()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
