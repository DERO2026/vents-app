// Client side of migration 0206 (audited two-admin earnings adjustments).
//
// The browser never writes a wallet or ledger row. It can only FILE a
// request through admin_request_earnings_adjustment, which snapshots the
// wallet server-side and goes into the existing maker-checker. A different
// super admin then approves it with approve_admin_action, and the server
// re-validates everything (both admins, neither the wallet owner, an
// unchanged wallet, the cap, the evidence) before anything moves.

export type EarningsAdjustmentKind = 'ledger_only' | 'wallet_credit' | 'wallet_debit' | 'late_recorded_payout';
export type EarningsAdjustmentDirection = 'credit' | 'debit';

export interface EarningsAdjustmentInput {
  organizerId: string;
  kind: EarningsAdjustmentKind;
  direction: EarningsAdjustmentDirection;
  amountKobo: number;
  reason: string;
  evidenceRef: string;
  withdrawalRequestId?: string;
  paidAt?: string; // ISO timestamp from the Paystack record (late_recorded_payout only)
}

/** Mirrors 0206's earnings_adjustment_cap_kobo(): NGN 50,000 per adjustment. */
export const EARNINGS_ADJUSTMENT_CAP_KOBO = 5_000_000;

const KINDS: EarningsAdjustmentKind[] = ['ledger_only', 'wallet_credit', 'wallet_debit', 'late_recorded_payout'];

/** Client-side checks that mirror the server's, for an early, clear error. The server remains authoritative. */
export function validateEarningsAdjustment(input: EarningsAdjustmentInput): string | null {
  if (!input.organizerId) return 'Choose the organizer whose wallet is being corrected.';
  if (!KINDS.includes(input.kind)) return 'Unknown adjustment kind.';
  if (input.direction !== 'credit' && input.direction !== 'debit') return 'Direction must be credit or debit.';
  if (input.kind === 'wallet_credit' && input.direction !== 'credit') return 'A wallet credit must be a credit.';
  if ((input.kind === 'wallet_debit' || input.kind === 'late_recorded_payout') && input.direction !== 'debit') {
    return 'A wallet debit or a late payout must be a debit.';
  }
  if (!Number.isInteger(input.amountKobo) || input.amountKobo <= 0) return 'The amount must be a positive whole number of kobo.';
  if (input.amountKobo > EARNINGS_ADJUSTMENT_CAP_KOBO) return 'The amount is above the ₦50,000 per-adjustment cap.';
  if ((input.reason || '').trim().length < 20) return 'Give a reason of at least 20 characters.';
  if (!(input.evidenceRef || '').trim()) return 'An evidence reference is required (e.g. the Paystack transfer code or ledger row).';
  if (input.kind === 'late_recorded_payout') {
    if (!input.withdrawalRequestId) return 'A late payout must name the withdrawal request.';
    if (!input.paidAt || Number.isNaN(Date.parse(input.paidAt))) return 'A late payout needs the date Paystack paid it.';
  } else if (input.withdrawalRequestId) {
    return 'Only a late payout names a withdrawal request.';
  }
  return null;
}

/** Arguments for the admin_request_earnings_adjustment RPC. */
export function earningsAdjustmentRpcArgs(input: EarningsAdjustmentInput) {
  return {
    p_organizer_id: input.organizerId,
    p_kind: input.kind,
    p_direction: input.direction,
    p_amount_kobo: input.amountKobo,
    p_reason: input.reason.trim(),
    p_evidence_ref: input.evidenceRef.trim(),
    p_withdrawal_request_id: input.kind === 'late_recorded_payout' ? input.withdrawalRequestId ?? null : null,
    p_paid_at: input.kind === 'late_recorded_payout' ? input.paidAt ?? null : null,
  };
}

/** Files the request (first admin). Nothing moves until a second, super admin approves it. */
export async function requestEarningsAdjustment(
  client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  input: EarningsAdjustmentInput,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const invalid = validateEarningsAdjustment(input);
  if (invalid) return { ok: false, error: invalid };
  const { data, error } = await client.rpc('admin_request_earnings_adjustment', earningsAdjustmentRpcArgs(input));
  if (error) return { ok: false, error: error.message };
  const id = (data as { id?: string } | null)?.id;
  return id ? { ok: true, requestId: id } : { ok: false, error: 'The server did not return a request id.' };
}

const naira = (kobo: unknown) =>
  typeof kobo === 'number' ? '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 }) : '?';

/** What the approving admin sees in Admin → Actions before approving. */
export function describeEarningsAdjustment(who: string, label: string, payload: Record<string, unknown> | null | undefined): string {
  const p = payload || {};
  const kind = typeof p.kind === 'string' && (KINDS as string[]).includes(p.kind) ? p.kind : `INVALID (${JSON.stringify(p.kind ?? null)})`;
  const effect =
    kind === 'ledger_only' ? 'ledger entry only, no wallet change'
      : kind === 'wallet_credit' ? 'ADDS to the available balance'
        : kind === 'wallet_debit' ? 'REMOVES from the available balance'
          : kind === 'late_recorded_payout' ? 'records a payout Paystack already made (balance unchanged)'
            : 'unknown effect';
  return `${who} requested an EARNINGS ADJUSTMENT (${kind}, ${String(p.direction ?? '?')}) of ${naira(p.amount_kobo)} for ${label}: ${effect}. `
    + `Reason: ${String(p.reason ?? '—')}. Evidence: ${String(p.evidence_ref ?? '—')}. `
    + `Reviewed balance ${naira(p.expected_balance_kobo)}; it is refused if the wallet has changed since.`;
}
