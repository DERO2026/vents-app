// VENTS-to-VENTS transfers between spendable VENTS Wallets (0215).
//
// The database is the only authority: transfer_wallet_funds checks the PIN,
// limits, balance, recipient and idempotency key in one transaction and
// moves both sides of the money atomically. Nothing here decides whether a
// transfer may happen; these helpers only shape requests and explain the
// server's answers.
import { supabase } from './supabase';

export interface TransferPolicy {
  min_kobo: number;
  max_kobo: number;
  daily_kobo: number;
  daily_count: number;
  min_account_age_hours: number;
  note_max_length: number;
}

export interface TransferStatus {
  enabled: boolean;
  username: string | null;
  policy: TransferPolicy;
  sent_today_kobo: number;
  sent_today_count: number;
  remaining_today_kobo: number;
  account_ok: boolean;
  account_old_enough: boolean;
  email_verified: boolean;
  has_pin: boolean;
  pin_locked: boolean;
  pin_paused_until: string | null;
}

export interface TransferRecipient {
  id: string;
  username: string;
  name: string;
  avatar_url: string | null;
  is_verified: boolean;
}

export interface TransferResult {
  ok: boolean;
  replayed?: boolean;
  reference?: string;
  transferId?: string;
  amountKobo?: number;
  balanceKobo?: number;
  code?: string;
  message?: string;
  attemptsLeft?: number;
}

export interface TransferReceipt {
  reference: string;
  status: 'completed';
  amount_kobo: number;
  note: string | null;
  created_at: string;
  direction: 'in' | 'out';
  sender: { username: string | null; name: string | null };
  recipient: { username: string | null; name: string | null };
}

/**
 * Why Send / Receive can or cannot be used right now. The wallet always shows
 * all three actions; when transfers are unavailable it says which of these
 * reasons applies instead of hiding them.
 *   not_deployed -- the database has no 0215 (get_my_wallet_transfer_status
 *                   does not exist), so transfers cannot run at all;
 *   disabled     -- 0215 is installed but the VENTS Admin kill switch
 *                   (app_config.disable_wallet_transfers, ON by default) is on;
 *   error        -- the status check itself failed (network, permission...);
 *   ready        -- the server says transfers are enabled.
 */
export type TransferAvailability =
  | { kind: 'loading' }
  | { kind: 'not_deployed' }
  | { kind: 'disabled'; status: TransferStatus }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: TransferStatus };

export async function fetchTransferAvailability(): Promise<TransferAvailability> {
  try {
    const status = await fetchTransferStatus();
    if (!status) return { kind: 'not_deployed' };
    return status.enabled ? { kind: 'ready', status } : { kind: 'disabled', status };
  } catch (e: any) {
    return { kind: 'error', message: e?.message || 'Could not check transfers' };
  }
}

/** Plain-language reason Send / Receive are unavailable, for everyone; null when they are available. */
export function transferUnavailableText(a: TransferAvailability): string | null {
  switch (a.kind) {
    case 'ready': return null;
    case 'loading': return 'Checking whether sending money is available…';
    case 'not_deployed': return 'Sending and receiving money between VENTS users isn\'t live yet. Deposits and wallet payments work as normal.';
    case 'disabled': return 'Sending and receiving money is paused by VENTS right now. Your balance is safe, and deposits and wallet payments work as normal.';
    case 'error': return 'We couldn\'t check whether sending money is available. Check your connection and try again.';
  }
}

/** The technical reason, shown only to VENTS staff. */
export function transferUnavailableStaffText(a: TransferAvailability): string | null {
  switch (a.kind) {
    case 'not_deployed': return 'Staff: migration 0215 (wallet transfers) is not applied on this database, so get_my_wallet_transfer_status does not exist.';
    case 'disabled': return 'Staff: 0215 is applied; the kill switch is on (app_config.disable_wallet_transfers). The VENTS Admin turns it off in System → Wallet Transfers.';
    case 'error': return `Staff: get_my_wallet_transfer_status failed: ${a.message}`;
    default: return null;
  }
}

/**
 * A reason this user cannot send right now even though transfers are on
 * (the server enforces every one of these again; this only saves the user
 * from filling the form in first). A missing PIN is not a block: the Send
 * sheet creates it.
 */
export function sendBlockReason(s: TransferStatus, now: Date = new Date()): string | null {
  if (!s.account_ok) return 'Your account can\'t send money right now. Contact support if you think this is a mistake.';
  if (!s.email_verified) return 'Verify your email address to send money.';
  if (!s.account_old_enough) return `New accounts can send money ${s.policy?.min_account_age_hours ?? 24} hours after signing up.`;
  if (s.pin_locked) return 'Your PIN is locked after too many wrong attempts. Sending money and withdrawals are paused for now. Reset your PIN in Earnings → PIN.';
  if (s.pin_paused_until && new Date(s.pin_paused_until) > now) {
    return `Your PIN was changed recently. For your security, sending money resumes ${new Date(s.pin_paused_until).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}.`;
  }
  if (s.remaining_today_kobo <= 0 || (s.policy && s.sent_today_count >= s.policy.daily_count)) return 'You have reached today\'s sending limit. Try again tomorrow.';
  return null;
}

/** The status RPC does not exist on a database without 0215: treated as "not available yet". */
export async function fetchTransferStatus(): Promise<TransferStatus | null> {
  const { data, error } = await supabase.rpc('get_my_wallet_transfer_status' as any);
  if (error) {
    if (/function .* does not exist|Could not find the function|PGRST202/i.test(`${error.message} ${(error as any).code ?? ''}`)) return null;
    throw new Error(error.message);
  }
  return (data as TransferStatus) ?? null;
}

export function normalizeUsernameInput(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

export function usernameProblem(raw: string): string | null {
  const u = normalizeUsernameInput(raw);
  if (!u) return 'Enter their VENTS username';
  if (!/^[a-z0-9._]{2,40}$/.test(u)) return 'Usernames use letters, numbers, dots and underscores';
  return null;
}

export async function findRecipient(username: string): Promise<{ recipient?: TransferRecipient; code?: string; message?: string }> {
  const { data, error } = await supabase.rpc('find_wallet_transfer_recipient' as any, { p_username: normalizeUsernameInput(username) });
  if (error) {
    if (/rate_limited/.test(error.message)) return { code: 'rate_limited', message: 'Too many searches. Try again in a few minutes.' };
    throw new Error(error.message);
  }
  const d = data as any;
  if (d?.ok) return { recipient: d.recipient as TransferRecipient };
  return { code: d?.code, message: d?.message || 'That user could not be found' };
}

/** Naira text typed by a user -> integer kobo, or null if it is not a valid amount. */
export function parseNairaToKobo(input: string): number | null {
  const s = input.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const kobo = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/** Mirrors the server's checks so the user hears about a problem before entering the PIN. The server decides. */
export function transferAmountProblem(kobo: number | null, balanceKobo: number, status: TransferStatus | null): string | null {
  if (kobo === null || kobo <= 0) return 'Enter an amount';
  const p = status?.policy;
  if (p && kobo < p.min_kobo) return `The minimum is ${formatNaira(p.min_kobo)}`;
  if (p && kobo > p.max_kobo) return `The maximum per transfer is ${formatNaira(p.max_kobo)}`;
  if (status && kobo > status.remaining_today_kobo) return `You can send ${formatNaira(status.remaining_today_kobo)} more today`;
  if (kobo > balanceKobo) return 'More than your VENTS Wallet balance';
  return null;
}

export function formatNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** One key per transfer attempt; a retry of the same attempt reuses it, so it can never pay twice. */
export function newTransferKey(): string {
  const c: any = (globalThis as any).crypto;
  const raw = c?.randomUUID ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `vt-${raw}`.replace(/[^A-Za-z0-9_-]/g, '');
}

export async function sendMoney(recipientId: string, amountKobo: number, note: string, pin: string, idempotencyKey: string): Promise<TransferResult> {
  const { data, error } = await supabase.rpc('transfer_wallet_funds' as any, {
    p_recipient_id: recipientId,
    p_amount_kobo: amountKobo,
    p_note: note.trim() || null,
    p_pin: pin,
    p_idempotency_key: idempotencyKey,
  });
  if (error) {
    if (/rate_limited/.test(error.message)) return { ok: false, code: 'rate_limited', message: 'Too many attempts. Try again later.' };
    throw new Error(error.message);
  }
  const d = data as any;
  if (d?.ok) {
    return { ok: true, replayed: d.replayed === true, reference: d.reference, transferId: d.transfer_id, amountKobo: Number(d.amount_kobo), balanceKobo: d.balance_kobo == null ? undefined : Number(d.balance_kobo) };
  }
  return { ok: false, code: d?.code, message: d?.message || 'The transfer was not sent', attemptsLeft: typeof d?.attempts_left === 'number' ? d.attempts_left : undefined };
}

export async function fetchTransferReceipt(reference: string): Promise<TransferReceipt | null> {
  const { data, error } = await supabase.rpc('get_my_wallet_transfer' as any, { p_reference: reference });
  if (error) throw new Error(error.message);
  return (data as TransferReceipt) ?? null;
}

// ── Receive: a link (and QR code) that opens Send Money to this username ──
export const PAY_LINK_BASE = 'https://getvents.com';
export const PAY_PARAM = 'pay';
export const PAY_TO_STORAGE_KEY = 'vents_pay_to';
/** A tapped "Money sent / received" notification: the wallet opens that transfer's receipt. */
export const WALLET_RECEIPT_STORAGE_KEY = 'vents_wallet_receipt';

export function payLinkFor(username: string): string {
  return `${PAY_LINK_BASE}/?${PAY_PARAM}=${encodeURIComponent(username)}`;
}

/** The username in a ?pay= link, or null. Only a well-formed username is accepted. */
export function usernameFromPayParam(value: string | null): string | null {
  if (!value) return null;
  const u = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{2,40}$/.test(u) ? u : null;
}

/** Plain-language reason for a refusal code; the server's own message is used when there is no better one. */
export function transferRefusalText(r: TransferResult): string {
  switch (r.code) {
    case 'transfers_disabled': return 'Sending money is not available yet.';
    case 'insufficient_funds': return 'Not enough money in your VENTS Wallet. Deposit funds first.';
    case 'wrong_pin': return r.message || 'Wrong PIN.';
    case 'pin_not_set': return 'Create your 4-digit VENTS PIN first. It protects transfers and withdrawals.';
    case 'pin_locked': case 'pin_reset_required': return r.message || 'Your PIN is locked. Reset it with your password in the Earnings tab.';
    case 'account_too_new': return 'New accounts can send money 24 hours after signing up.';
    case 'email_not_verified': return 'Verify your email before sending money.';
    case 'replayed': return 'This transfer was already sent.';
    default: return r.message || 'The transfer was not sent.';
  }
}
