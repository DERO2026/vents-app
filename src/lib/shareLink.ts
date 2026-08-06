import { Capacitor } from '@capacitor/core';

// Every share button in the app used to call navigator.share directly —
// works, but it's the Web Share API rather than the native plugin already
// proven reliable for ticket sharing (see ticketImage.ts), and support for
// text/url payloads varies more across WebView versions than the native
// dialog does. Consolidates on @capacitor/share on native, falls back to
// navigator.share on web (Capacitor.isNativePlatform() is false there),
// and finally to clipboard if neither is available. Returns 'shared' /
// 'copied' / 'cancelled' so callers can show the right toast.
export async function shareLink(opts: { title?: string; text?: string; url?: string }): Promise<'shared' | 'copied' | 'cancelled'> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: opts.title });
      return 'shared';
    } catch {
      return 'cancelled';
    }
  }
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title: opts.title, text: opts.text, url: opts.url });
      return 'shared';
    } catch {
      return 'cancelled';
    }
  }
  if (!opts.url) return 'cancelled';
  try {
    await navigator.clipboard.writeText(opts.url);
    return 'copied';
  } catch {
    return 'cancelled';
  }
}
