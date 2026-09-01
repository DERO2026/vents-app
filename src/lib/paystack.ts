/**
 * Paystack Inline Payment Wrapper
 *
 * Loads the Paystack popup (the CDN script in index.html injects `PaystackPop`
 * on `window`). Amounts must be in KOBO (Naira × 100).
 */

declare global {
  interface Window {
    PaystackPop?: {
      setup(options: PaystackOptions): { openIframe(): void };
    };
  }
}

interface PaystackOptions {
  key: string;
  email: string;
  amount: number; // in kobo
  currency?: string;
  ref?: string;
  label?: string;
  channels?: string[];
  metadata?: Record<string, any>;
  callback(response: { reference: string }): void;
  onClose(): void;
}

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
  channels?: string[];  // Paystack payment channels; defaults to all
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

/**
 * Opens the Paystack payment popup. This is the single place in the app
 * that reads VITE_PAYSTACK_PUBLIC_KEY and calls window.PaystackPop.setup() —
 * every payment entry point (ticket checkout, event promotion) goes through
 * here, so there's exactly one code path to audit for which Paystack mode
 * (test vs live) a build is running in.
 * Requires VITE_PAYSTACK_PUBLIC_KEY in vercel.json env.
 * The Paystack inline script is loaded via index.html.
 */
export function openPaystackPopup(opts: OpenPaystackOptions): void {
  const rawKey = (import.meta.env.VITE_PAYSTACK_PUBLIC_KEY as string | undefined) || '';
  const publicKey = rawKey.replace(/^\uFEFF/, '').trim();

  if (!publicKey) {
    const message = 'Payment system not configured. Please try again later.';
    console.error('[Paystack] VITE_PAYSTACK_PUBLIC_KEY is not set.');
    (opts.onError || opts.onClose)(message);
    return;
  }

  if (!window.PaystackPop) {
    const message = 'Payment system not loaded. Please refresh the page and try again.';
    console.error(
      '[Paystack] PaystackPop not available — ensure ' +
      '<script src="https://js.paystack.co/v1/inline.js"></script> is in index.html'
    );
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

  const handler = window.PaystackPop.setup({
    key: publicKey,
    email: opts.email,
    amount,
    currency: 'NGN',
    ref: opts.ref || `vents_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    label: opts.label,
    channels: opts.channels || ['card', 'bank_transfer', 'ussd', 'mobile_money', 'bank'],
    metadata: opts.metadata || {},
    callback(response) {
      opts.onSuccess({ reference: response.reference });
    },
    onClose() {
      opts.onClose();
    },
  });

  handler.openIframe();
}
