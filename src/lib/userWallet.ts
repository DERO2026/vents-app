// Data-layer helpers for the customer-facing VENTS Wallet (0065_user_wallets.sql).
// Deliberately separate from anything organizer/provider-earnings-related
// (organizer_wallets, WalletScreen.tsx) and from VENTS Cents
// (vents_wallets/vc_transactions) -- this is a third, independent system:
// a deposit-funded, spendable, NEVER-withdrawable NGN balance.

import { supabase, getAuthToken } from './supabase';
import { openPaystackPopup } from './paystack';
import { apiUrl } from './apiBase';
import { Sentry } from './sentry';

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
  // Server-durable diagnostics for the Wallet Deposit flow -- replaces the
  // earlier browser-console-only logging, which produced no evidence once
  // the tab closed. Every breadcrumb below is attached to the Sentry event
  // fired at the bottom of this function on any non-success outcome, so
  // the full sequence survives past the browser session. Never includes
  // secrets, card data, auth tokens, or PII -- only the reference, amounts,
  // and HTTP-level facts already visible to this client itself.
  Sentry.addBreadcrumb({ category: 'wallet_deposit', message: 'requested', level: 'info', data: { amountKobo } });

  const { data, error } = await supabase.rpc('initiate_wallet_deposit', { p_amount_kobo: amountKobo });
  if (error) {
    Sentry.captureException(error, { tags: { flow: 'wallet_deposit', step: 'initiate_wallet_deposit' } });
    throw new Error(error.message);
  }
  const reference: string = data?.reference;
  const chargeAmountKobo: number = Number(data?.amountKobo) || amountKobo;

  Sentry.addBreadcrumb({
    category: 'wallet_deposit',
    message: 'initiate_wallet_deposit response',
    level: 'info',
    data: { reference, rawAmountKoboFromRpc: data?.amountKobo, resolvedChargeAmountKobo: chargeAmountKobo },
  });

  if (!reference) {
    Sentry.captureMessage('wallet_deposit: initiate_wallet_deposit returned no reference', {
      level: 'error',
      tags: { flow: 'wallet_deposit', step: 'initiate_wallet_deposit' },
      extra: { amountKobo, rpcData: data },
    });
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
          Sentry.addBreadcrumb({ category: 'wallet_deposit', message: 'paystack callback fired, calling verify', level: 'info', data: { reference } });

          const token = await getAuthToken();
          const verifyRes = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ reference }),
          });
          const verifyJson = await verifyRes.json().catch(() => null);

          Sentry.addBreadcrumb({
            category: 'wallet_deposit',
            message: 'verify response',
            level: 'info',
            data: { reference, httpStatus: verifyRes.status, responseStatus: verifyJson?.status, responseError: verifyJson?.error },
          });

          if (!verifyRes.ok || verifyJson?.status !== 'success') {
            const resolvedError = verifyJson?.error || 'Could not verify your deposit. If you were charged, contact support with your reference.';
            // This is the exact server-observed outcome for this deposit --
            // captured as its own event (not just a breadcrumb) so it shows
            // up as a distinct, searchable issue in Sentry, carrying every
            // breadcrumb logged above with it.
            Sentry.captureMessage('wallet_deposit: verify did not return success', {
              level: 'error',
              tags: { flow: 'wallet_deposit', step: 'verify' },
              extra: { reference, requestedAmountKobo: amountKobo, chargeAmountKobo, httpStatus: verifyRes.status, verifyResponse: verifyJson },
            });
            resolve({ status: 'error', error: resolvedError });
            return;
          }
          Sentry.addBreadcrumb({ category: 'wallet_deposit', message: 'verify succeeded', level: 'info', data: { reference } });
          resolve({ status: 'success' });
        } catch (e: any) {
          Sentry.captureException(e, {
            tags: { flow: 'wallet_deposit', step: 'verify_fetch' },
            extra: { reference, requestedAmountKobo: amountKobo, chargeAmountKobo },
          });
          resolve({ status: 'error', error: e?.message || 'Could not verify your deposit.' });
        }
      },
      onClose: () => {
        // Popup closed with no callback ever firing -- either the user
        // cancelled, or Paystack's own checkout UI rejected/errored the
        // transaction before completion. Captured as its own event (not
        // just a breadcrumb) specifically so this case is distinguishable
        // in Sentry from a verify-endpoint failure: if the next real
        // deposit attempt logs THIS event and nothing from the "verify
        // response" breadcrumb above, that on its own proves the failure
        // is inside Paystack's popup/SDK, not this app's server code.
        Sentry.captureMessage('wallet_deposit: Paystack popup closed without a successful callback', {
          level: 'info',
          tags: { flow: 'wallet_deposit', step: 'paystack_popup_closed' },
          extra: { reference, requestedAmountKobo: amountKobo, chargeAmountKobo },
        });
        resolve({ status: 'error', error: 'cancelled' });
      },
      onError: (message) => {
        Sentry.captureMessage('wallet_deposit: Paystack popup setup error', {
          level: 'error',
          tags: { flow: 'wallet_deposit', step: 'paystack_popup_error' },
          extra: { reference, requestedAmountKobo: amountKobo, chargeAmountKobo, message },
        });
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
