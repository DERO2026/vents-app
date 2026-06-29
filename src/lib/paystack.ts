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
  amountNaira: number; // in Naira — converted to kobo internally
  channels?: string[];  // Paystack payment channels; defaults to all
  metadata?: Record<string, any>;
  onSuccess(response: PaystackSuccessResponse): void;
  onClose(): void;
}

/**
 * Opens the Paystack payment popup.
 * Requires VITE_PAYSTACK_PUBLIC_KEY in vercel.json env.
 * The Paystack inline script is loaded via index.html.
 */
export function openPaystackPopup(opts: OpenPaystackOptions): void {
  const publicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY as string | undefined;

  if (!publicKey) {
    console.error('[Paystack] VITE_PAYSTACK_PUBLIC_KEY is not set.');
    opts.onClose();
    return;
  }

  if (!window.PaystackPop) {
    console.error(
      '[Paystack] PaystackPop not available — ensure ' +
      '<script src="https://js.paystack.co/v1/inline.js"></script> is in index.html'
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
