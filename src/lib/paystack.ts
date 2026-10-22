/**
 * Paystack Inline Payment Wrapper
 *
 * Uses @paystack/inline-js v2 (npm, bundled — no CDN <script> tag needed;
 * see index.html, which previously loaded v1/inline.js as a global). V1's
 * channels option has no documented support for Apple Pay / Google Pay —
 * both are only documented against v2's newTransaction()/checkout(), per
 * the package's own README (fetched and inspected directly, not guessed).
 * Amounts must be in KOBO (Naira × 100).
 */
import PaystackPop from '@paystack/inline-js';
import { Capacitor } from '@capacitor/core';

export interface PaystackSuccessResponse {
  reference: string;
}

export interface OpenPaystackOptions {
  email: string;
  // Exactly one of these must be set. amountKobo takes precedence when both
  // are present — server-computed amounts (e.g. create_pending_purchase's
  // amount_kobo) are already exact integer kobo, so routing them through
  // amountNaira's Naira→kobo Math.round() would be a pointless, riskier
  // round-trip for no benefit.
  amountNaira?: number; // in Naira — converted to kobo internally
  amountKobo?: number;
  // Paystack payment channels; defaults to all channels this build offers
  // (see DEFAULT_CHANNELS below) — callers should normally omit this and
  // let the default decide, rather than hand-list channels themselves.
  channels?: string[];
  metadata?: Record<string, any>;
  // Caller-supplied transaction reference — e.g. a server-generated
  // payment_ref from create_pending_purchase, so the webhook can match
  // this transaction back to the pending purchase it belongs to. Falls
  // back to a locally-generated one for callers with no server-side
  // reference to reconcile against (e.g. PromoteEventScreen.tsx).
  ref?: string;
  // Shown on the Paystack popup itself (e.g. the payer's display name).
  label?: string;
  onSuccess(response: PaystackSuccessResponse): void;
  onClose(): void;
  // Distinguishes a real configuration/setup failure (missing key, script
  // not loaded) from the user simply dismissing the popup — callers that
  // want to surface a specific error message (e.g. CheckoutScreen.tsx's
  // payError banner) can implement this; onClose() alone can't tell the
  // two apart. Falls back to onClose() when omitted, matching the
  // previous behavior of every existing caller.
  onError?(message: string): void;
}

// Apple Pay and Google Pay are web-wallet mechanisms: both require the
// TOP-LEVEL page origin to be a domain the wallet provider has verified
// (Apple Pay via the merchant-domain-association file + Paystack Dashboard
// registration; Google Pay via a registered origin in the Google Pay
// merchant console). Inside the Capacitor native app, the WebView's origin
// is https://localhost (capacitor.config.ts: server.hostname = 'localhost'),
// never https://getvents.com — no domain verification can ever attach to
// that origin, on either platform. Paystack's own hosted checkout iframe
// has no way to make that work either, since the wallet's own JS APIs key
// off the PARENT page's origin, not the iframe's src. So these channels are
// web-build-only; the native app's channel list is completely unchanged
// from before this change, which is also what keeps this change from
// having any ability to alter native-app behavior at all.
const WALLET_CHANNELS = ['apple_pay', 'google_pay'];
const BASE_CHANNELS = ['card', 'bank_transfer', 'ussd', 'mobile_money', 'bank'];

function defaultChannels(): string[] {
  if (Capacitor.isNativePlatform()) return BASE_CHANNELS;
  // google_pay must be passed alongside card or the transaction refuses to
  // initialize (per @paystack/inline-js's own README) — card is already in
  // BASE_CHANNELS, so this is satisfied. Paystack's hosted checkout iframe
  // itself decides, per visiting browser/device, whether to actually show
  // either wallet button — listing them here only makes both ELIGIBLE, it
  // never fabricates a button for a browser/device that can't use one.
  return [...BASE_CHANNELS, ...WALLET_CHANNELS];
}

// One PaystackPop instance for the module's lifetime, per the package's own
// documented pattern (`const paystackInstance = new PaystackPop();`, reused
// across calls) rather than constructing a new one per payment attempt.
let paystackInstance: PaystackPop | null = null;
function getPaystackInstance(): PaystackPop {
  if (!paystackInstance) paystackInstance = new PaystackPop();
  return paystackInstance;
}

/**
 * Opens the Paystack payment popup. This is the single place in the app
 * that reads VITE_PAYSTACK_PUBLIC_KEY and talks to @paystack/inline-js —
 * every payment entry point (ticket checkout, event promotion) goes through
 * here, so there's exactly one code path to audit for which Paystack mode
 * (test vs live) a build is running in, and for which channels (including
 * the wallets) are offered.
 * Requires VITE_PAYSTACK_PUBLIC_KEY in vercel.json env.
 */
export function openPaystackPopup(opts: OpenPaystackOptions): void {
  const rawKey = (import.meta.env.VITE_PAYSTACK_PUBLIC_KEY as string | undefined) || '';
  const publicKey = rawKey.replace(/^﻿/, '').trim();

  if (!publicKey) {
    const message = 'Payment system not configured. Please try again later.';
    console.error('[Paystack] VITE_PAYSTACK_PUBLIC_KEY is not set.');
    (opts.onError || opts.onClose)(message);
    return;
  }

  const amount = opts.amountKobo != null ? Math.round(opts.amountKobo) : Math.round((opts.amountNaira || 0) * 100);
  if (!amount || amount <= 0) {
    const message = 'Invalid payment amount.';
    console.error('[Paystack] openPaystackPopup called with no positive amountNaira/amountKobo.');
    (opts.onError || opts.onClose)(message);
    return;
  }

  const resolvedRef = opts.ref || `vents_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    getPaystackInstance().newTransaction({
      key: publicKey,
      email: opts.email,
      amount,
      currency: 'NGN',
      reference: resolvedRef,
      channels: opts.channels || defaultChannels(),
      metadata: opts.metadata || {},
      onSuccess(response: { reference: string }) {
        opts.onSuccess({ reference: response.reference });
      },
      onCancel() {
        opts.onClose();
      },
      onError(error: { message: string }) {
        (opts.onError || opts.onClose)(error?.message || 'Payment could not be completed.');
      },
    } as any);
  } catch (err: any) {
    console.error('[Paystack] newTransaction threw:', err?.message || err);
    (opts.onError || opts.onClose)(err?.message || 'Payment system not loaded. Please refresh the page and try again.');
  }
}
