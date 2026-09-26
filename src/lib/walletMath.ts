// Pure, client-side mirrors of the money math the deployed Postgres
// functions are the real authority on (initiate_wallet_deposit,
// confirm_ticket_payment_via_wallet — see live schema audit). Used for
// UI-side validation/estimates only; every server RPC re-derives and
// enforces these numbers itself, so a mismatch here can only produce a
// confusing client-side message, never an incorrect charge.

// Mirrors initiate_wallet_deposit's own bounds (min NGN 500 / max NGN
// 5,000,000, expressed in kobo there as 50000 / 500000000).
export const WALLET_DEPOSIT_MIN_KOBO = 50_000;
export const WALLET_DEPOSIT_MAX_KOBO = 500_000_000;

export function validateWalletDepositAmountKobo(amountKobo: number): string | null {
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) return 'Enter a valid amount.';
  if (amountKobo < WALLET_DEPOSIT_MIN_KOBO) return 'Minimum deposit is ₦500.';
  if (amountKobo > WALLET_DEPOSIT_MAX_KOBO) return 'Maximum single deposit is ₦5,000,000.';
  return null;
}

// Mirrors confirm_ticket_payment_via_wallet's v_expected_kobo:
//   round(total_amount * (1.05 - discount_pct/100) * 100)
// where total_amount is the Naira subtotal (unit price * quantity) BEFORE
// the 5% VENTS fee, and discount_pct is a promo code's percentage-off
// applied to the fee-inclusive rate. The organizer/provider is credited
// the base subtotal in full (100%) separately -- this function only
// computes what the buyer's wallet is charged.
export function computeTicketWalletChargeKobo(subtotalNaira: number, discountPct = 0): number {
  return Math.round(subtotalNaira * (1.05 - discountPct / 100) * 100);
}

export function hasSufficientBalance(balanceKobo: number, chargeKobo: number): boolean {
  return balanceKobo >= chargeKobo;
}

// Wallet transaction display helpers, shared by CustomerWalletScreen.
// user_wallet_transactions.type is DB-CHECK-constrained to 'deposit' |
// 'spend' | 'refund' (0075_wallet_refund_fee_ledger_and_error_hardening.sql)
// with amount_kobo always stored positive regardless of direction -- the
// sign/label is purely a display concern, computed from `type` here.
// 'deposit' and 'refund' both increase the balance (a refund credits money
// back after a ticket refund); only 'spend' decreases it.
export type WalletTxnType = 'deposit' | 'spend' | 'refund' | string;

export function isWalletCredit(type: WalletTxnType): boolean {
  return type === 'deposit' || type === 'refund';
}

export const WALLET_TXN_TYPE_LABEL: Record<string, string> = {
  deposit: 'Wallet Deposit',
  spend: 'Purchase',
  refund: 'Refund',
};

export function walletTxnLabel(type: WalletTxnType, description?: string | null): string {
  if (description) return description;
  return WALLET_TXN_TYPE_LABEL[type] || 'Wallet Adjustment';
}
