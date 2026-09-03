// Shared by api/webhook/paystack.ts (the authoritative path, triggered by
// Paystack's own signed webhook event) and api/payments/verify.ts (the
// client-triggered "I'm back from Paystack, verify me" path, triggered
// only after that endpoint's own server-side call to Paystack's
// GET /transaction/verify/:reference confirms status === 'success').
// Kept as one function so the two paths can never drift out of sync --
// whichever of them runs first wins, the other is a no-op against the same
// locked pending_purchases/tickets rows (see finalize_pending_purchase's
// and confirm_ticket_payment's own idempotency).
import { callProjectAdminRpc, callProjectAdminTableRpc } from './projectAdminDb.js';

export type FinalizeResult =
  | { status: 'confirmed' | 'already_paid'; ticketIds: string[] }
  | { status: 'amount_mismatch'; expectedKobo: number; gotKobo: number }
  | { status: 'not_found' };

export async function finalizeAndConfirmPurchase(reference: string, amountKobo: number): Promise<FinalizeResult> {
  // Recovery path: creates the ticket row(s) from the payment intent
  // persisted by create_pending_purchase (CheckoutScreen.tsx) BEFORE
  // Paystack ever opened, if they don't already exist. Idempotent — locks
  // the pending_purchases row FOR UPDATE, no-ops if already 'completed'. A
  // reference that never went through create_pending_purchase (free
  // ticket, or some other path) has no pending_purchases row and this
  // RAISEs "not found", which is expected and non-fatal here.
  try {
    await callProjectAdminRpc('finalize_pending_purchase', [reference]);
  } catch (err: any) {
    console.warn('[finalizeAndConfirmPurchase] finalize_pending_purchase no-op/failed for', reference, '-', err?.message || err);
  }

  // The actual payment-confirmed marker: verifies the amount matches, no-ops
  // if already paid, otherwise flips payment_status + credits the organizer
  // wallet + notifies, all atomically.
  const status = await callProjectAdminRpc<string>('confirm_ticket_payment', [reference, amountKobo]);

  if (typeof status === 'string' && status.startsWith('amount_mismatch')) {
    const [, expected, got] = status.split(':');
    return { status: 'amount_mismatch', expectedKobo: Number(expected), gotKobo: Number(got) };
  }
  if (status === 'not_found') return { status: 'not_found' };

  const rows = await callProjectAdminTableRpc<{ id: string }>('get_tickets_for_payment_ref', [reference]).catch(() => []);
  const ticketIds = rows.map((r) => r.id);

  return { status: status === 'already_paid' ? 'already_paid' : 'confirmed', ticketIds };
}
