import { describe, it, expect } from 'vitest';
import {
  validateWalletDepositAmountKobo,
  computeTicketWalletChargeKobo,
  hasSufficientBalance,
  isWalletCredit,
  walletTxnLabel,
  WALLET_DEPOSIT_MIN_KOBO,
  WALLET_DEPOSIT_MAX_KOBO,
} from './walletMath';

describe('validateWalletDepositAmountKobo', () => {
  it('rejects zero/negative/NaN amounts', () => {
    expect(validateWalletDepositAmountKobo(0)).toMatch(/valid amount/i);
    expect(validateWalletDepositAmountKobo(-100)).toMatch(/valid amount/i);
    expect(validateWalletDepositAmountKobo(NaN)).toMatch(/valid amount/i);
  });

  it('enforces the same minimum as initiate_wallet_deposit (NGN 500)', () => {
    expect(validateWalletDepositAmountKobo(WALLET_DEPOSIT_MIN_KOBO - 1)).toMatch(/minimum/i);
    expect(validateWalletDepositAmountKobo(WALLET_DEPOSIT_MIN_KOBO)).toBeNull();
  });

  it('enforces the same maximum as initiate_wallet_deposit (NGN 5,000,000)', () => {
    expect(validateWalletDepositAmountKobo(WALLET_DEPOSIT_MAX_KOBO + 1)).toMatch(/maximum/i);
    expect(validateWalletDepositAmountKobo(WALLET_DEPOSIT_MAX_KOBO)).toBeNull();
  });

  it('accepts a normal deposit amount', () => {
    expect(validateWalletDepositAmountKobo(500_000)).toBeNull(); // NGN 5,000
  });
});

describe('computeTicketWalletChargeKobo', () => {
  it('charges subtotal + 5% VENTS fee with no promo', () => {
    // NGN 1,000 subtotal -> buyer pays 1,050.00 -> 105000 kobo
    expect(computeTicketWalletChargeKobo(1000, 0)).toBe(105_000);
  });

  it('applies a promo discount to the fee-inclusive rate, matching the SQL formula', () => {
    // round(1000 * (1.05 - 10/100) * 100) = round(1000*0.95*100) = 95000
    expect(computeTicketWalletChargeKobo(1000, 10)).toBe(95_000);
  });

  it('never charges a fee on a free ticket', () => {
    expect(computeTicketWalletChargeKobo(0, 0)).toBe(0);
  });
});

describe('hasSufficientBalance', () => {
  it('rejects a balance below the charge', () => {
    expect(hasSufficientBalance(10_000, 10_001)).toBe(false);
  });

  it('accepts a balance exactly equal to the charge', () => {
    expect(hasSufficientBalance(10_000, 10_000)).toBe(true);
  });

  it('accepts a balance above the charge', () => {
    expect(hasSufficientBalance(20_000, 10_000)).toBe(true);
  });
});

// Regression tests for the CustomerWalletScreen wallet-refund bug: refunds
// are a valid, always-positive-amount DB transaction type
// (user_wallet_transactions_type_check allows 'deposit'|'spend'|'refund',
// confirmed live) that credits the customer's balance back after a ticket
// refund -- but the screen only ever treated 'deposit' as a credit, so
// every refund rendered as "-₦X" in the debit color, looking like a charge
// instead of money returned.
describe('isWalletCredit', () => {
  it('treats a deposit as a credit', () => {
    expect(isWalletCredit('deposit')).toBe(true);
  });

  it('treats a refund as a credit', () => {
    expect(isWalletCredit('refund')).toBe(true);
  });

  it('treats a spend as a debit', () => {
    expect(isWalletCredit('spend')).toBe(false);
  });

  it('treats an unrecognized type as a debit (safe default)', () => {
    expect(isWalletCredit('something_new')).toBe(false);
  });
});

describe('walletTxnLabel', () => {
  it('labels a refund as "Refund" when there is no description', () => {
    expect(walletTxnLabel('refund', null)).toBe('Refund');
  });

  it('labels a deposit as "Wallet Deposit" when there is no description', () => {
    expect(walletTxnLabel('deposit', null)).toBe('Wallet Deposit');
  });

  it('labels a spend as "Purchase" when there is no description', () => {
    expect(walletTxnLabel('spend', undefined)).toBe('Purchase');
  });

  it('prefers a real description over the type-based label', () => {
    expect(walletTxnLabel('refund', 'Refund for Ticket #123')).toBe('Refund for Ticket #123');
  });

  it('falls back to "Wallet Adjustment" for an unrecognized type with no description', () => {
    expect(walletTxnLabel('something_new', null)).toBe('Wallet Adjustment');
  });
});
