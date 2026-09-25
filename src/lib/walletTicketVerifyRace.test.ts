import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real production bug found via Sentry (JAVASCRIPT-REACT-1G) + Supabase
// cross-reference: a ticket paid via VENTS Wallet (payment_method='wallet')
// was already fully confirmed and issued by confirm_ticket_payment_via_
// wallet (0066) -- but App.tsx's handleCheckoutSuccess unconditionally
// re-verified EVERY non-free ticket through api/webhook/paystack.ts's
// ?action=verify, passing it the wallet payment_ref as if it were a real
// Paystack transaction reference. Paystack correctly had no record of it
// ("Transaction reference not found."), and the client threw that as an
// uncaught Error -- even though the purchase had already succeeded.
//
// Confirmed via direct Supabase query during the incident: the ticket's
// payment_ref VNT-1a5c1b820bc3467dada60b7f7e433725 was marked
// payment_status='paid', payment_method='wallet' at 01:42:14 UTC; the
// Sentry error fired for the same order 3 seconds later.

let checkoutSrc: string;
let appSrc: string;

beforeAll(() => {
  checkoutSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'CheckoutScreen.tsx'), 'utf8');
  appSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
});

describe('Wallet-paid tickets never trigger a Paystack re-verification', () => {
  it('CheckoutScreen marks a wallet-paid ticket with skipPaymentVerification', () => {
    const walletBranch = checkoutSrc.match(/if \(paymentMethod === 'wallet'\) \{[\s\S]*?onSuccess\(ticket\);\s*\n\s*return;/)?.[0] ?? '';
    expect(walletBranch).toMatch(/skipPaymentVerification: true,/);
  });

  it("App.tsx's handleCheckoutSuccess gains a skipPaymentVerification branch that reads the ticket back directly instead of calling Paystack verify", () => {
    expect(appSrc).toMatch(/\} else if \(ticket\.skipPaymentVerification\) \{/);
    // Isolate just this branch's own body (up to the next `} else {`) so
    // "does it call verify" only checks this branch, not the file as a whole.
    const startIdx = appSrc.indexOf('} else if (ticket.skipPaymentVerification) {');
    const endIdx = appSrc.indexOf('generate_ticket_token', startIdx);
    const branch = appSrc.slice(startIdx, endIdx + 200);
    // (not a bare "action=verify" substring check -- this branch's own
    // explanatory comment mentions that string, deliberately, as the
    // failure mode it avoids)
    expect(branch).not.toMatch(/apiUrl\('\/api\/webhook\/paystack\?action=verify'\)/);
    expect(branch).not.toMatch(/fetch\(/);
    expect(branch).toMatch(/\.from\('tickets'\)/);
    expect(branch).toMatch(/\.eq\('payment_ref', ticket\.ticketId\)/);
    expect(branch).toMatch(/\.eq\('user_id', currentUser\.id\)/);
    expect(branch).toMatch(/generate_ticket_token/);
  });

  it('the real Paystack path (non-wallet) is unchanged -- still calls ?action=verify with ticket.ticketId', () => {
    expect(appSrc).toMatch(/apiUrl\('\/api\/webhook\/paystack\?action=verify'\)/);
    expect(appSrc).toMatch(/body: JSON\.stringify\(\{ reference: ticket\.ticketId \}\)/);
  });
});
