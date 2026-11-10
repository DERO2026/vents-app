
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

// Ticket charges are not computed here: checkout displays the database's
// quote (src/lib/ticketQuote.ts, ticket_fee_quote) and the server charges
// exactly that amount.

export function hasSufficientBalance(balanceKobo: number, chargeKobo: number): boolean {
  return balanceKobo >= chargeKobo;
}

// Wallet transaction display helpers, shared by the unified wallet.
// user_wallet_transactions.type is DB-CHECK-constrained (0065, 0146, 0215)
// to 'deposit' | 'spend' | 'refund' | 'vc_conversion' | 'transfer_out' |
// 'transfer_in', with amount_kobo always stored positive regardless of
// direction -- the sign/label is purely a display concern, computed from
// `type` here. Money in: deposit, refund, vc_conversion (VC converted into
// naira) and transfer_in. Money out: spend and transfer_out.
export type WalletTxnType = 'deposit' | 'spend' | 'refund' | 'vc_conversion' | 'transfer_out' | 'transfer_in' | string;

const WALLET_CREDIT_TYPES = new Set(['deposit', 'refund', 'vc_conversion', 'transfer_in']);
const WALLET_DEBIT_TYPES = new Set(['spend', 'transfer_out']);

export function isWalletCredit(type: WalletTxnType): boolean {
  return WALLET_CREDIT_TYPES.has(type);
}

/** 'in' | 'out' | 'unknown' -- an unknown future type is never shown as money in or out by guesswork. */
export function walletTxnDirection(type: WalletTxnType): 'in' | 'out' | 'unknown' {
  if (WALLET_CREDIT_TYPES.has(type)) return 'in';
  if (WALLET_DEBIT_TYPES.has(type)) return 'out';
  return 'unknown';
}

export const WALLET_TXN_TYPE_LABEL: Record<string, string> = {
  deposit: 'Wallet Deposit',
  spend: 'Purchase',
  refund: 'Refund',
  vc_conversion: 'VENTS Cents converted',
  transfer_out: 'Money sent',
  transfer_in: 'Money received',
};

export function walletTxnLabel(type: WalletTxnType, description?: string | null): string {
  if (description) return description;
  return WALLET_TXN_TYPE_LABEL[type] || 'Wallet Adjustment';
}
