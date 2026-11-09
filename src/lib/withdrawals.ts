// Withdrawals (0211): one vocabulary for every screen. The stage always
// comes from the database (admin_list_withdrawals / get_my_withdrawals);
// nothing here decides who may do what -- the server refuses anything else.
import { supabase } from './supabase';

export type WithdrawalStage =
  | 'pending_first_approval'
  | 'pending_second_approval'
  | 'approved'
  | 'processing'
  | 'paid'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'reversed';

export type StageTone = 'wait' | 'progress' | 'ok' | 'bad' | 'neutral';

export const WITHDRAWAL_STAGES: Record<WithdrawalStage, { user: string; admin: string; tone: StageTone; detail: string }> = {
  pending_first_approval: {
    user: 'Waiting for first approval', admin: 'Needs 1st approval', tone: 'wait',
    detail: 'Two different VENTS admins must approve every withdrawal.',
  },
  pending_second_approval: {
    user: 'Waiting for second approval', admin: 'Needs 2nd approval', tone: 'wait',
    detail: 'One admin approved it. A second, different admin must approve it too.',
  },
  approved: {
    user: 'Approved · sending soon', admin: 'Approved · ready to pay', tone: 'progress',
    detail: 'Approved by two admins. It will be sent to your bank shortly.',
  },
  processing: {
    user: 'Sending to your bank', admin: 'Processing (Paystack)', tone: 'progress',
    detail: 'The transfer is with Paystack. It is marked paid only when Paystack confirms it.',
  },
  paid: { user: 'Paid', admin: 'Paid', tone: 'ok', detail: 'Paystack confirmed the transfer to your bank.' },
  rejected: { user: 'Not approved', admin: 'Rejected', tone: 'bad', detail: 'The money is back in your available balance.' },
  failed: { user: 'Failed', admin: 'Failed', tone: 'bad', detail: 'The transfer failed. The money is back in your available balance.' },
  cancelled: { user: 'Cancelled', admin: 'Cancelled', tone: 'neutral', detail: 'The money is back in your available balance.' },
  reversed: { user: 'Reversed', admin: 'Reversed', tone: 'bad', detail: 'Paystack reversed the transfer. The money is back in your available balance.' },
};

export function stageInfo(stage: string | null | undefined) {
  return WITHDRAWAL_STAGES[(stage as WithdrawalStage)] ?? { user: stage || 'Unknown', admin: stage || 'Unknown', tone: 'neutral' as StageTone, detail: '' };
}

export const STAGE_TONE_COLORS: Record<StageTone, { fg: string; bg: string }> = {
  wait: { fg: '#FBBF24', bg: 'rgba(251,191,36,0.12)' },
  progress: { fg: '#60A5FA', bg: 'rgba(96,165,250,0.12)' },
  ok: { fg: '#34D399', bg: 'rgba(52,211,153,0.12)' },
  bad: { fg: '#F87171', bg: 'rgba(248,113,113,0.12)' },
  neutral: { fg: '#9CA3AF', bg: 'rgba(156,163,175,0.12)' },
};

// ── Withdrawal PIN ───────────────────────────────────────────────────────
export interface WithdrawalPinStatus {
  has_pin: boolean;
  locked: boolean;
  locked_until: string | null;
  must_reset: boolean;
  attempts_left: number;
  withdrawals_paused_until: string | null;
}

export const PIN_LENGTH = 4;

/** Mirrors the server's checks so the user hears about them before submitting. The server is the authority. */
export function pinProblem(pin: string, confirm?: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'Your withdrawal PIN must be exactly 4 digits';
  if (confirm !== undefined && confirm !== pin) return 'The two PINs do not match';
  if (/^(\d)\1{3}$/.test(pin) || /^(\d\d)\1$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    return 'That PIN is too easy to guess (like 1111, 1234 or 1212). Choose another';
  }
  return null;
}

export function normalizePinStatus(d: any): WithdrawalPinStatus | null {
  if (!d || typeof d !== 'object') return null;
  return {
    has_pin: d.has_pin === true,
    locked: d.locked === true,
    locked_until: typeof d.locked_until === 'string' ? d.locked_until : null,
    must_reset: d.must_reset === true,
    attempts_left: typeof d.attempts_left === 'number' ? d.attempts_left : 0,
    withdrawals_paused_until: typeof d.withdrawals_paused_until === 'string' ? d.withdrawals_paused_until : null,
  };
}

export async function fetchPinStatus(): Promise<WithdrawalPinStatus | null> {
  const { data, error } = await supabase.rpc('get_my_withdrawal_pin_status' as any);
  if (error) throw new Error(error.message);
  return normalizePinStatus(data);
}

export async function createPin(pin: string, confirm: string): Promise<WithdrawalPinStatus | null> {
  const { data, error } = await supabase.rpc('set_my_withdrawal_pin' as any, { p_pin: pin, p_pin_confirm: confirm });
  if (error) throw new Error(error.message);
  return normalizePinStatus(data);
}

/** Result of request_withdrawal: ok, or a refusal the user can act on. */
export interface WithdrawalResult {
  ok: boolean;
  requestId?: string;
  replayed?: boolean;
  /** Set when ok is false: pin_not_set, wrong_pin, pin_locked, pin_reset_required, pin_recently_reset, amount_too_small, duplicate_withdrawal. */
  code?: string;
  message?: string;
  attemptsLeft?: number;
}

export function parseWithdrawalResult(d: any): WithdrawalResult {
  if (d && d.ok === true && typeof d.request_id === 'string') {
    return { ok: true, requestId: d.request_id, replayed: d.replayed === true };
  }
  return {
    ok: false,
    code: typeof d?.code === 'string' ? d.code : 'unknown',
    message: typeof d?.message === 'string' ? d.message : 'The withdrawal could not be requested',
    attemptsLeft: typeof d?.attempts_left === 'number' ? d.attempts_left : undefined,
  };
}

export async function requestWithdrawal(amountKobo: number, bankAccountId: string, pin: string, idempotencyKey: string): Promise<WithdrawalResult> {
  const { data, error } = await supabase.rpc('request_withdrawal' as any, {
    p_amount_kobo: amountKobo,
    p_bank_account_id: bankAccountId,
    p_pin: pin,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error(error.message);
  return parseWithdrawalResult(data);
}

export interface MyWithdrawal {
  request_id: string;
  amount_kobo: number;
  status: string;
  stage: WithdrawalStage;
  bank_name: string | null;
  account_number_masked: string | null;
  created_at: string;
  updated_at: string | null;
  note: string | null;
}

export async function fetchMyWithdrawals(limit = 50): Promise<MyWithdrawal[]> {
  const { data, error } = await supabase.rpc('get_my_withdrawals' as any, { p_limit: limit });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as MyWithdrawal[];
}

// ── Admin ────────────────────────────────────────────────────────────────
export interface AdminWithdrawal {
  request_id: string;
  organizer_id: string;
  organizer_name: string | null;
  organizer_email: string | null;
  organizer_phone: string | null;
  amount_kobo: number;
  status: string;
  stage: WithdrawalStage;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  bank_account_active: boolean;
  created_at: string;
  updated_at: string | null;
  admin_note: string | null;
  first_approval_id: string | null;
  first_approved_by: string | null;
  first_approved_by_name: string | null;
  first_approved_by_tier: 'full' | 'sub' | null;
  first_approved_at: string | null;
  second_approved_by: string | null;
  second_approved_by_name: string | null;
  second_approved_at: string | null;
  paystack_reference: string | null;
  transfer_started: boolean;
  can_first_approve: boolean;
  can_second_approve: boolean;
  can_cancel_first_approval: boolean;
  can_pay: boolean;
  can_reject: boolean;
  action_note: string | null;
}

export async function fetchAdminWithdrawals(scope: 'open' | 'closed' | 'all', limit = 100): Promise<AdminWithdrawal[]> {
  const { data, error } = await supabase.rpc('admin_list_withdrawals' as any, { p_scope: scope, p_limit: limit });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as AdminWithdrawal[];
}

export async function adminFirstApprove(requestId: string, amountKobo: number): Promise<void> {
  const { error } = await supabase.rpc('admin_first_approve_withdrawal' as any, { p_request_id: requestId, p_amount_kobo: amountKobo });
  if (error) throw new Error(error.message);
}

export async function adminSecondApprove(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('admin_approve_withdrawal' as any, { p_request_id: requestId });
  if (error) throw new Error(error.message);
}

export async function adminCancelFirstApproval(requestId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('admin_cancel_withdrawal_first_approval' as any, { p_request_id: requestId, p_reason: reason });
  if (error) throw new Error(error.message);
}
