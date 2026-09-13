import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression guard for the "no stale Paystack verification" requirement:
// a wallet-completed ticket purchase (confirm_ticket_payment_via_wallet
// already ran, atomically, server-side) must never be routed through
// api/webhook/paystack?action=verify -- that endpoint calls Paystack's own
// GET /transaction/verify/:reference, which has no matching transaction for
// a purchase that never went through Paystack at all.
//
// App.tsx has no unit-test harness for its React component tree, so this
// inspects the actual committed source of handleWalletCheckoutSuccess (the
// wallet-purchase completion handler wired to CheckoutScreen's
// onWalletSuccess) directly, rather than re-deriving the same logic in a
// parallel implementation that could drift from what's really shipped.
describe('wallet ticket purchase completion path', () => {
  const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf-8');

  function extractFunctionBody(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = useCallback`);
    expect(start, `${name} not found in App.tsx`).toBeGreaterThan(-1);
    // Find the matching closing "}, [" of this useCallback (its dependency
    // array line) by scanning forward from start -- good enough for this
    // file's consistent formatting without pulling in a real TS parser.
    const depsMarker = source.indexOf('\n  }, [', start);
    expect(depsMarker, `could not find end of ${name}`).toBeGreaterThan(start);
    return source.slice(start, depsMarker);
  }

  it('handleWalletCheckoutSuccess never calls the Paystack verify endpoint', () => {
    const body = extractFunctionBody(appSource, 'handleWalletCheckoutSuccess');
    expect(body).not.toMatch(/action=verify/);
    expect(body).not.toMatch(/webhook\/paystack/);
  });

  it('handleWalletCheckoutSuccess calls confirm_ticket_payment_via_wallet\'s result via a direct ticket lookup, not create/finalize RPCs meant for the Paystack path', () => {
    const body = extractFunctionBody(appSource, 'handleWalletCheckoutSuccess');
    expect(body).not.toMatch(/finalize_pending_purchase/);
    expect(body).not.toMatch(/purchase_ticket_with_tokens/);
  });

  it('sanity check: the Paystack completion handler (handleCheckoutSuccess) DOES call the verify endpoint', () => {
    const body = extractFunctionBody(appSource, 'handleCheckoutSuccess');
    expect(body).toMatch(/action=verify/);
  });
});
