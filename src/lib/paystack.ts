/**
 * Paystack Inline Payment Wrapper
 *
 * Loads the Paystack popup (the CDN script in index.html injects `PaystackPop`
 * on `window`). Amounts must be in KOBO (Naira × 100).
 *
 * Usage:
 *   openPaystackPopup({ email, amountKobo, metadata, onSuccess, onClose });
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
  metadata?: Record<string, any>;
  callback(response: { reference: string }): void;
  onClose(): void;
}

export interface PaystackSuccessResponse {
  reference: string;
}

export interface OpenPaystackOptions {
  email: string;
  amountNaira: number; // in Naira — we convert to kobo internally
  metadata?: Record<string, any>;
  onSuccess(response: PaystackSuccessResponse): void;
  onClose(): void;
}

/**
 * Opens the Paystack payment popup.
 * Requires `VITE_PAYSTACK_PUBLIC_KEY` in your .env.local.
 * The Paystack inline script must be loaded via index.html.
 */
export function openPaystackPopup(opts: OpenPaystackOptions): void {
  const publicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY as string | undefined;

  if (!publicKey) {
    console.error(
      '[Paystack] VITE_PAYSTACK_PUBLIC_KEY is not set in .env.local. ' +
      'Get your key from https://dashboard.paystack.com/#/settings/developer'
    );
    opts.onClose();
    return;
  }

  if (!window.PaystackPop) {
    console.error(
      '[Paystack] PaystackPop is not available. ' +
      'Ensure the script tag is in index.html: ' +
      '<script src="https://js.paystack.co/v1/inline.js"></script>'
    );
    opts.onClose();
    return;
  }

  const handler = window.PaystackPop.setup({
    key: publicKey,
    email: opts.email,
    amount: Math.round(opts.amountNaira * 100), // Naira → kobo
    currency: 'NGN',
    ref: `vents_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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
