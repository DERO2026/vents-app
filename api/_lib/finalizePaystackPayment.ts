// Shared by api/webhook/paystack.ts's two entry points: the authoritative
// path (triggered by Paystack's own signed webhook event) and the
// ?action=verify path (the client-triggered "I'm back from Paystack,
// verify me" path, triggered only after that path's own server-side call
// to Paystack's
// GET /transaction/verify/:reference confirms status === 'success').
// Kept as one function so the two paths can never drift out of sync --
// whichever of them runs first wins, the other is a no-op against the same
// locked pending_purchases/tickets rows (see finalize_pending_purchase's
// and confirm_ticket_payment's own idempotency).
import { callProjectAdminRpc, callProjectAdminTableRpc } from './projectAdminDb.js';

export type FinalizeResult =
  | { status: 'confirmed' | 'already_paid'; ticketIds: string[] }
  // Payment IS genuinely confirmed at this point (confirm_ticket_payment
  // already succeeded, payment_status is 'paid', the organizer wallet was
  // already credited) -- this only means the follow-up ticket-id lookup
  // itself failed (e.g. a transient project_admin connection hiccup), not
  // that anything about the payment failed. Kept distinct from
  // { ticketIds: [] } on purpose so a caller can never mistake "we
  // couldn't read the ids back right now" for "no ticket exists" -- the
  // former must never be presented to the customer as a failed payment.
  | { status: 'confirmed_lookup_failed' }
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

  // Deliberately NOT swallowed into an empty ticketIds array on failure --
  // that would make a genuinely successful, already-confirmed payment look
  // identical to "no ticket exists", which callers use to decide whether
  // to show the customer a failure. A real lookup failure here is reported
  // as its own distinct status instead.
  let ticketIds: string[];
  try {
    const rows = await callProjectAdminTableRpc<{ id: string }>('get_tickets_for_payment_ref', [reference]);
    ticketIds = rows.map((r) => r.id);
  } catch (err: any) {
    console.error('[finalizeAndConfirmPurchase] get_tickets_for_payment_ref failed AFTER payment was confirmed for', reference, '-', err?.message || err);
    return { status: 'confirmed_lookup_failed' };
  }

  return { status: status === 'already_paid' ? 'already_paid' : 'confirmed', ticketIds };
}

export type ServiceBookingFinalizeResult =
  | { status: 'confirmed' | 'already_paid' }
  | { status: 'amount_mismatch'; expectedKobo: number; gotKobo: number }
  | { status: 'not_found' };

// Services marketplace equivalent of finalizeAndConfirmPurchase, for
// 'BKG-' prefixed references (create_service_booking,
// 0054_service_bookings_marketplace.sql). No separate "finalize" step is
// needed here (unlike tickets) -- create_service_booking already writes the
// full service_bookings/service_booking_items rows synchronously before
// Paystack ever opens, so there's nothing left to recover; only the
// pending->paid transition itself needs confirming.
export async function finalizeAndConfirmServiceBooking(reference: string, amountKobo: number): Promise<ServiceBookingFinalizeResult> {
  const status = await callProjectAdminRpc<string>('confirm_service_booking_payment', [reference, amountKobo]);

  if (typeof status === 'string' && status.startsWith('amount_mismatch')) {
    const [, expected, got] = status.split(':');
    return { status: 'amount_mismatch', expectedKobo: Number(expected), gotKobo: Number(got) };
  }
  if (status === 'not_found') return { status: 'not_found' };
  return { status: status === 'already_paid' ? 'already_paid' : 'confirmed' };
}
