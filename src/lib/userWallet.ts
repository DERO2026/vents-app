// Data-layer helpers for the customer-facing VENTS Wallet (0065_user_wallets.sql).
// Deliberately separate from anything organizer/provider-earnings-related
// (organizer_wallets, WalletScreen.tsx) and from VENTS Cents
// (vents_wallets/vc_transactions) -- this is a third, independent system:
// a deposit-funded, spendable, NEVER-withdrawable NGN balance.

import { supabase, getAuthToken } from './supabase';
import { openPaystackPopup } from './paystack';
import { apiUrl } from './apiBase';

export interface UserWalletTransaction {
  id: string;
  type: 'deposit' | 'spend' | 'refund';
  amountKobo: number;
  description: string | null;
  referenceId: string | null;
  createdAt: string;
}

function mapTransactionRow(row: any): UserWalletTransaction {
  return {
    id: row.id,
    type: row.type,
    amountKobo: Number(row.amount_kobo),
    description: row.description ?? null,
    referenceId: row.reference_id ?? null,
    createdAt: row.created_at,
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
  if (error) throw new Error(error.message);
  const reference: string = data?.reference;
  const chargeAmountKobo: number = Number(data?.amountKobo) || amountKobo;
  if (!reference) throw new Error('Could not start the deposit.');

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
            resolve({ status: 'error', error: verifyJson?.error || 'Could not verify your deposit. If you were charged, contact support with your reference.' });
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
