// H1 / OEL-02 (docs/repair-tracker.md, migration 0226).
//
// A Paystack ticket payment that was captured but could not become a ticket
// is recorded in payment_exceptions (one row per reference, idempotent) so
// an admin can see it and resolve it. Recording only: nothing here refunds
// or moves money -- how those refunds are authorized is owner decision D4.
//
// Shared by both entry points in api/webhook/paystack.ts (?action=verify and
// the signed webhook) so they can never disagree.
import { callProjectAdminRpc } from './projectAdminDb.js';
import type { FinalizeResult } from './finalizePaystackPayment.js';

export type PaymentExceptionSource = 'verify' | 'webhook';

/** True only when the reference is provably a ticket purchase: either a
 *  pending purchase exists for it, or it is a ticket payment-attempt
 *  reference ('PSK-', 0060). Every paid ticket goes through
 *  create_pending_purchase, so a real ticket payment always qualifies.
 *  Anything else that reaches the ticket fallback (an event promotion's
 *  client-generated 'vents_…' reference, verified separately by
 *  api/promotions/activate.ts) is NOT a ticket and must not be recorded. */
export function isTicketPurchaseReference(reference: string, hasPendingPurchase: boolean): boolean {
  return hasPendingPurchase || reference.startsWith('PSK-');
}

/** Records the exception. Throws if the database call fails, so the signed
 *  webhook can answer 500 and let Paystack retry (the record is idempotent). */
export async function recordPaymentException(args: {
  reference: string;
  paymentRef: string | null;
  result: Extract<FinalizeResult, { status: 'not_found' | 'amount_mismatch' }>;
  amountKobo: number;
  source: PaymentExceptionSource;
}): Promise<void> {
  const { reference, paymentRef, result, amountKobo, source } = args;
  const detail = result.status === 'not_found' ? (result.finalizeError ?? null) : null;
  const expected = result.status === 'amount_mismatch' ? result.expectedKobo : null;
  await callProjectAdminRpc('record_payment_exception', [
    reference, paymentRef, result.status, detail, amountKobo, expected, source,
  ]);
}

/** Closes an open exception when a later retry did issue the ticket.
 *  Best effort: a failure here never affects the buyer's confirmed ticket. */
export async function markPaymentExceptionTicketed(reference: string): Promise<void> {
  try {
    await callProjectAdminRpc('mark_payment_exception_ticketed', [reference]);
  } catch (err: any) {
    console.warn('[paymentExceptions] mark_payment_exception_ticketed failed for', reference, '-', err?.message || err);
  }
}

/** What the buyer is told. They were charged, so never "no order found" /
 *  "payment failed": say the payment was received, why the ticket wasn't
 *  issued when we know, and that it is recorded with their reference. */
export function buyerMessageForException(
  result: Extract<FinalizeResult, { status: 'not_found' | 'amount_mismatch' }>,
  reference: string,
): string {
  const why = result.status === 'not_found' && result.finalizeError
    ? ` (${result.finalizeError.replace(/\.$/, '')})`
    : result.status === 'amount_mismatch'
      ? ' (the amount paid did not match the order)'
      : '';
  return `We received your payment, but your ticket could not be issued${why}. `
    + `It has been recorded under reference ${reference} and our team will contact you to resolve it.`;
}
