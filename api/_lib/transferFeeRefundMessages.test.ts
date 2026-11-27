import { describe, it, expect } from 'vitest';
import { transferFeeProblemMessage, transferFeeProblemOf, transferFeeRefundStateText, transferFeeExcessNotice, type TransferFeeRefundState } from './transferFeeRefundMessages';

// Each refund state has its own wording; only 'submitted' and later mention
// Paystack, only 'succeeded' says it is completed, and none promises a date.
describe('transfer-fee refund messages', () => {
  const states: TransferFeeRefundState[] = ['not_recorded', 'pending_review', 'approved', 'submitted', 'succeeded', 'failed'];
  it('six distinct states', () => {
    expect(new Set(states.map(transferFeeRefundStateText)).size).toBe(6);
  });
  it('no state promises a date or "shortly"', () => {
    for (const st of states) expect(transferFeeRefundStateText(st)).not.toMatch(/shortly|within|days?\b|hours?\b|business/i);
  });
  it('only states at or after submission mention Paystack; only succeeded says completed', () => {
    expect(transferFeeRefundStateText('not_recorded')).not.toMatch(/Paystack/);
    expect(transferFeeRefundStateText('pending_review')).not.toMatch(/Paystack/);
    expect(transferFeeRefundStateText('submitted')).toMatch(/sent to Paystack/);
    expect(transferFeeRefundStateText('succeeded')).toMatch(/completed/);
    for (const st of states.filter((x) => x !== 'succeeded')) expect(transferFeeRefundStateText(st)).not.toMatch(/has been completed/);
  });
  it('not_recorded never says a refund started', () => {
    expect(transferFeeRefundStateText('not_recorded')).toMatch(/No refund has been started yet/);
  });
  it('classifies every confirm answer', () => {
    expect(transferFeeProblemOf('expired')).toBe('expired');
    expect(transferFeeProblemOf('transfer_not_pending:cancelled')).toBe('cancelled');
    expect(transferFeeProblemOf('transfer_not_pending:accepted')).toBe('not_pending');
    expect(transferFeeProblemOf('ticket_ineligible')).toBe('ticket_ineligible');
    expect(transferFeeProblemOf('not_found')).toBe('not_found');
    expect(transferFeeProblemOf('amount_mismatch:1:2')).toBe('underpaid');
    expect(transferFeeProblemOf('duplicate_payment')).toBe('duplicate');
    expect(transferFeeProblemOf('confirmed')).toBeNull();
    expect(transferFeeProblemOf('already_paid')).toBeNull();
    expect(transferFeeProblemOf(null)).toBeNull();
  });
  it('messages always carry the payment reference', () => {
    expect(transferFeeProblemMessage('expired', 'not_recorded', 'txf_abc')).toContain('txf_abc');
    expect(transferFeeExcessNotice('txf_abc')).toContain('txf_abc');
  });
});
