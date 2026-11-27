// What a ticket-transfer recipient is told about a transfer fee that was paid
// but could not complete the transfer (P0 follow-up, 2026-11-27).
//
// Production (0043 + an untracked amount-rule edit, no 0064/0233/0238) told
// these payers "a refund has been started automatically and should appear on
// your statement shortly" although no refund was started or recorded. The
// rule now: a message may only say what the database has recorded.
//
//   not_recorded   the database recorded no refund (production today):
//                  say so, give the reference, point to support.
//   pending_review a payment exception is recorded for the two-admin refund
//                  (':refund_queued', 0238/0239): awaiting approval.
//   approved       approved by two admins, not yet sent to Paystack.
//   submitted      sent to Paystack (a Paystack refund id exists).
//   succeeded      Paystack reported the refund processed.
//   failed         Paystack reported the refund failed; VENTS follows up.
//
// No message promises a date: Paystack does not give one we can verify.

export type TransferFeeRefundState = 'not_recorded' | 'pending_review' | 'approved' | 'submitted' | 'succeeded' | 'failed';

export type TransferFeeProblem = 'expired' | 'cancelled' | 'not_pending' | 'ticket_ineligible' | 'not_found' | 'underpaid' | 'duplicate';

const PROBLEM_TEXT: Record<TransferFeeProblem, string> = {
  expired: 'This transfer request expired before your payment was confirmed',
  cancelled: 'This transfer was cancelled before your payment was confirmed',
  not_pending: 'This transfer is no longer pending',
  ticket_ineligible: 'This ticket can no longer be transferred',
  not_found: 'We received your payment but could not match it to a transfer',
  underpaid: 'The amount paid was less than the transfer fee, so the transfer was not completed',
  duplicate: 'This transfer had already been paid for, so this payment was not needed',
};

const STATE_TEXT: Record<TransferFeeRefundState, string> = {
  not_recorded: 'No refund has been started yet. Please contact VENTS support with this reference so it can be refunded.',
  pending_review: 'A refund has been recorded and is waiting for approval by VENTS. You will be notified when it is sent.',
  approved: 'Your refund has been approved and will be sent to Paystack.',
  submitted: 'Your refund has been sent to Paystack. Paystack will return it to your original payment method.',
  succeeded: 'Your refund has been completed by Paystack.',
  failed: 'Your refund could not be completed by Paystack. VENTS support will contact you.',
};

export function transferFeeRefundStateText(state: TransferFeeRefundState): string {
  return STATE_TEXT[state];
}

/** The verify response for a paid fee that did not (or need not) complete a transfer. */
export function transferFeeProblemMessage(problem: TransferFeeProblem, state: TransferFeeRefundState, reference: string): string {
  return `${PROBLEM_TEXT[problem]}. Your payment reference is ${reference}. ${STATE_TEXT[state]}`;
}

/** Classify confirm_transfer_fee_payment's answer (suffixes already split off). */
export function transferFeeProblemOf(feeStatus: unknown): TransferFeeProblem | null {
  if (typeof feeStatus !== 'string') return null;
  if (feeStatus === 'expired') return 'expired';
  if (feeStatus === 'ticket_ineligible') return 'ticket_ineligible';
  if (feeStatus === 'transfer_not_pending:cancelled' || feeStatus === 'transfer_not_pending:declined') return 'cancelled';
  if (feeStatus.startsWith('transfer_not_pending')) return 'not_pending';
  if (feeStatus === 'not_found') return 'not_found';
  if (feeStatus.startsWith('amount_mismatch')) return 'underpaid';
  if (feeStatus === 'duplicate_payment') return 'duplicate';
  return null;
}

/** 0239: the transfer completed; the amount paid above the fee is owed back. */
export function transferFeeExcessNotice(reference: string): string {
  return `Your transfer is complete. You paid more than the transfer fee; the extra amount has been recorded for a refund and is waiting for approval by VENTS. Your payment reference is ${reference}.`;
}
