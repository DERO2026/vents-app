// Data-layer helpers for the customer-facing VENTS Wallet (0065_user_wallets.sql).
// Deliberately separate from anything organizer/provider-earnings-related
// (organizer_wallets, WalletScreen.tsx) and from VENTS Cents
// (vents_wallets/vc_transactions) -- this is a third, independent system:
// a deposit-funded, spendable, NEVER-withdrawable NGN balance.

import { supabase, getAuthToken } from './supabase';
import { openPaystackPopup } from './paystack';
import { apiUrl } from './apiBase';
export { classifyWalletTransaction, type WalletTransactionKind } from './walletTransactionClassifier';

export interface UserWalletTransaction {
  id: string;
  type: 'deposit' | 'spend' | 'refund';
  amountKobo: number;
  description: string | null;
  referenceId: string | null;
  createdAt: string;
  // get_my_wallet_transactions returns SETOF user_wallet_transactions, whose
  // metadata column already carries real, authoritative fields depending on
  // type -- confirm_wallet_deposit writes paystack_reference/paystack_
  // verified_amount_kobo (0065), refund_ticket writes ticket_id/
  // platform_fee_absorbed_kobo (0075). Previously fetched but silently
  // dropped by this mapper -- never shown anywhere, even though it was
  // already authoritative, server-written data.
  metadata: Record<string, unknown>;
}

function mapTransactionRow(row: any): UserWalletTransaction {
  return {
    id: row.id,
    type: row.type,
    amountKobo: Number(row.amount_kobo),
    description: row.description ?? null,
    referenceId: row.reference_id ?? null,
    createdAt: row.created_at,
    metadata: (row.metadata && typeof row.metadata === 'object') ? row.metadata : {},
  };
}

// Lazily creates the wallet row on first call (get_my_wallet, 0065) --
// there is no separate "does my wallet exist" check needed anywhere else.
export async function fetchMyWalletBalanceKobo(): Promise<number> {
  const { data, error } = await supabase.rpc('get_my_wallet');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return Number(row?.balance_kobo ?? 0);
}

export async function fetchMyWalletTransactions(limit = 50, offset = 0): Promise<UserWalletTransaction[]> {
  const { data, error } = await supabase.rpc('get_my_wallet_transactions', { p_limit: limit, p_offset: offset });
  if (error) throw error;
  return (data || []).map(mapTransactionRow);
}

export interface DepositResult {
  status: 'success' | 'error';
  error?: string;
}

// Opens the Paystack popup for a wallet top-up and resolves once the
// deposit has been server-verified (or definitively failed/cancelled).
// Mirrors MyTicketsScreen.tsx's handleAcceptTransfer -- the same initiate
// RPC -> Paystack popup -> ?action=verify -> resolve pattern already
// proven for ticket-transfer fee payments, just for a deposit instead of
// a fixed purchase price.
export async function depositToWallet(email: string, amountKobo: number): Promise<DepositResult> {
  const { data, error } = await supabase.rpc('initiate_wallet_deposit', { p_amount_kobo: amountKobo });
  if (error) {
    throw new Error(error.message);
  }
  const reference: string = data?.reference;
  const chargeAmountKobo: number = Number(data?.amountKobo) || amountKobo;

  if (!reference) {
    throw new Error('Could not start the deposit.');
  }

  return new Promise((resolve) => {
    openPaystackPopup({
      email,
      amountKobo: chargeAmountKobo,
      ref: reference,
      label: 'VENTS Wallet top-up',
      metadata: { kind: 'wallet_deposit' },
      onSuccess: async () => {
        try {
          const token = await getAuthToken();
          const verifyRes = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ reference }),
          });
          const verifyJson = await verifyRes.json().catch(() => null);

          if (!verifyRes.ok || verifyJson?.status !== 'success') {
            const resolvedError = verifyJson?.error || 'Could not verify your deposit. If you were charged, contact support with your reference.';
            resolve({ status: 'error', error: resolvedError });
            return;
          }
          resolve({ status: 'success' });
        } catch (e: any) {
          resolve({ status: 'error', error: e?.message || 'Could not verify your deposit.' });
        }
      },
      onClose: () => {
        resolve({ status: 'error', error: 'cancelled' });
      },
      onError: (message) => {
        resolve({ status: 'error', error: message });
      },
    });
  });
}

export interface WalletPaymentResult {
  status: 'success' | 'insufficient_balance' | 'error';
  /** Only set for status === 'insufficient_balance'. */
  balanceKobo?: number;
  neededKobo?: number;
  error?: string;
}

function parseWalletConfirmStatus(raw: string): WalletPaymentResult {
  if (raw === 'confirmed' || raw === 'already_paid') return { status: 'success' };
  if (raw === 'not_found') return { status: 'error', error: 'No matching purchase was found for this payment.' };
  if (typeof raw === 'string' && raw.startsWith('insufficient_balance')) {
    const [, have, need] = raw.split(':');
    return { status: 'insufficient_balance', balanceKobo: Number(have), neededKobo: Number(need) };
  }
  return { status: 'error', error: 'Wallet payment could not be completed.' };
}

// Pay for an existing ticket purchase (payment_ref from create_pending_
// purchase) directly out of the caller's own VENTS Wallet balance --
// 0066_wallet_payments.sql's confirm_ticket_payment_via_wallet. No
// Paystack popup involved: the wallet balance itself, checked and debited
// server-side under a row lock, is the proof of payment. Scoped to the
// ticket owner paying for themselves -- not available for a "Someone Else
// Pays" request (see that migration's header comment for why).
export async function payTicketWithWallet(paymentRef: string): Promise<WalletPaymentResult> {
  const { data, error } = await supabase.rpc('confirm_ticket_payment_via_wallet', { p_payment_ref: paymentRef });
  if (error) return { status: 'error', error: error.message };
  return parseWalletConfirmStatus(data as string);
}

// Pay for an existing Services marketplace booking (payment_ref from
// create_service_booking) directly out of the caller's own VENTS Wallet
// balance -- 0066_wallet_payments.sql's
// confirm_service_booking_payment_via_wallet. Same reasoning as
// payTicketWithWallet above.
export async function payServiceBookingWithWallet(paymentRef: string): Promise<WalletPaymentResult> {
  const { data, error } = await supabase.rpc('confirm_service_booking_payment_via_wallet', { p_reference: paymentRef });
  if (error) return { status: 'error', error: error.message };
  return parseWalletConfirmStatus(data as string);
}

// Resolves the first ticket id for a wallet-ticket-purchase's payment_ref,
// so a wallet transaction receipt can deep-link into My Tickets. A single
// purchase can create several ticket rows sharing one payment_ref (a group
// buy) -- the first (by created_at) is used as the representative ticket,
// same convention confirm_ticket_payment_via_wallet itself uses internally
// (v_first_ticket_id) for its own notification. Scoped implicitly by
// select_tickets' RLS (own rows only) -- never trusts or needs an explicit
// user_id filter here. Returns null on no match rather than throwing, since
// "can't deep-link" is a normal, safe outcome this caller already handles.
export async function findTicketIdForPaymentRef(paymentRef: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select('id')
    .eq('payment_ref', paymentRef)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.id as string;
}
