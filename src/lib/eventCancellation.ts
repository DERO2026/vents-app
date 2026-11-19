// Event cancellation (migration 0218): organizer request -> Super Admin
// decision -> refunds through the EXISTING per-ticket refund path.
//
// Nothing here decides an amount or marks anything refunded. Each claimed
// ticket is sent to /api/wallet/refund-ticket exactly as the attendee list's
// "Refund" button sends it: refund_ticket computes the amount server-side
// (wallet: credited at once; free: cancelled; Paystack: refund requested and
// confirmed later by the refund webhook). The database mirrors every ticket
// transition into the cancellation's refund rows; this module only reports a
// failed attempt's message.
import { supabase, getAuthToken } from './supabase';
import { apiUrl } from './apiBase';

export type CancellationStatus = 'requested' | 'rejected' | 'processing' | 'completed' | 'attention';
export type RefundRowStatus = 'queued' | 'processing' | 'refunded' | 'failed' | 'blocked';

export interface RefundProgress { total: number; refunded: number; processing: number; needs_attention: number }
export interface MyEventCancellation {
  id: string; event_id: string; status: CancellationStatus; reason: string;
  requested_at: string; decided_at: string | null; decision_note: string | null; completed_at: string | null;
  refunds: RefundProgress;
}
export interface MyCancellationRefund {
  ticket_id: string; event_id: string; status: RefundRowStatus; amount_kobo: number;
  payment_method: 'paystack' | 'wallet' | 'free'; refunded_at: string | null; updated_at: string;
}

export const CANCELLATION_STATUS_LABEL: Record<CancellationStatus, string> = {
  requested: 'Cancellation requested · under review',
  rejected: 'Cancellation not approved',
  processing: 'Cancelled · refunds processing',
  completed: 'Cancelled · all refunds completed',
  attention: 'Cancelled · some refunds need attention',
};

/** What a ticket holder sees for their own ticket of a cancelled event. */
export function attendeeRefundLabel(status: RefundRowStatus | undefined, paymentStatus?: string): string {
  if (paymentStatus === 'refunded' || status === 'refunded') return 'Refunded';
  if (status === 'failed' || status === 'blocked') return 'Refund needs attention · VENTS is on it';
  if (paymentStatus === 'refund_pending' || status === 'processing') return 'Refund processing';
  return 'Refund pending';
}

/** True when the database does not have the cancellation functions yet (0218 not applied). */
export function isCancellationUnavailable(e: { code?: string; message?: string } | null | undefined): boolean {
  return e?.code === 'PGRST202' || /could not find the function/i.test(e?.message || '');
}
export const CANCELLATION_UNAVAILABLE_MESSAGE =
  "Event cancellation isn't available in the app yet. Contact VENTS support to cancel this event; its ticket holders must be refunded.";

function rpcError(e: { code?: string; message?: string } | null, fallback: string): never {
  // Never show a raw PostgREST "function not found" message to a user.
  if (isCancellationUnavailable(e)) throw Object.assign(new Error(CANCELLATION_UNAVAILABLE_MESSAGE), { unavailable: true });
  throw new Error(e?.message || fallback);
}

export async function requestEventCancellation(eventId: string, reason: string): Promise<{ id: string; status: CancellationStatus }> {
  const { data, error } = await supabase.rpc('request_event_cancellation' as any, { p_event_id: eventId, p_reason: reason.trim() });
  if (error) rpcError(error, 'The cancellation request could not be sent.');
  return data as any;
}

export async function fetchMyEventCancellations(): Promise<MyEventCancellation[]> {
  const { data, error } = await supabase.rpc('get_my_event_cancellations' as any);
  if (error) rpcError(error, 'Could not load cancellation requests.');
  return (data as MyEventCancellation[]) ?? [];
}

export async function fetchMyCancellationRefunds(): Promise<MyCancellationRefund[]> {
  const { data, error } = await supabase.rpc('get_my_cancellation_refunds' as any);
  if (error) rpcError(error, 'Could not load refund statuses.');
  return (data as MyCancellationRefund[]) ?? [];
}

export async function adminListEventCancellations(status?: CancellationStatus): Promise<any[]> {
  const { data, error } = await supabase.rpc('admin_list_event_cancellations' as any, { p_status: status ?? null });
  if (error) rpcError(error, 'Could not load cancellation requests.');
  return (data as any[]) ?? [];
}

export async function adminGetEventCancellation(id: string): Promise<any> {
  const { data, error } = await supabase.rpc('admin_get_event_cancellation' as any, { p_request_id: id });
  if (error) rpcError(error, 'Could not load this cancellation request.');
  return data;
}

export async function adminDecideEventCancellation(id: string, approve: boolean, note: string): Promise<{ status: CancellationStatus; refunds_queued?: number }> {
  const { data, error } = await supabase.rpc('admin_decide_event_cancellation' as any, { p_request_id: id, p_approve: approve, p_note: note.trim() || null });
  if (error) rpcError(error, 'The decision could not be recorded.');
  return data as any;
}

export interface RefundRunResult { claimed: number; refunded: number; pending: number; failed: number; errors: string[] }

/**
 * One "Process refunds" run: claim up to `limit` tickets, then send each one
 * through the existing refund API. Returns what happened; the authoritative
 * state is re-read from the database afterwards.
 */
export async function processCancellationRefunds(id: string, limit = 10): Promise<RefundRunResult> {
  const { data, error } = await supabase.rpc('admin_claim_event_cancellation_refunds' as any, { p_request_id: id, p_limit: limit });
  if (error) rpcError(error, 'Refunds could not be started.');
  const claim = data as { reason: string; tickets: { ticket_id: string }[] };
  const result: RefundRunResult = { claimed: claim.tickets.length, refunded: 0, pending: 0, failed: 0, errors: [] };
  let limited: string | null = null;
  for (const { ticket_id } of claim.tickets) {
    let message: string | null = null;
    if (limited) {
      // A rate limit was hit earlier in this run: skip calls that would be
      // refused too. Recorded as failed (so they don't sit claimed for 15
      // minutes) and retried on the next run; a row that ran out of attempts
      // this way can be re-queued (adminRequeueCancellationRefund).
      message = limited;
    } else try {
      const token = await getAuthToken();
      const res = await fetch(apiUrl('/api/wallet/refund-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ticket_id, reason: claim.reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        message = json?.error || `Refund failed (HTTP ${res.status})`;
        if (res.status === 429 || /rate.?limit|too many/i.test(String(json?.error || ''))) {
          limited = 'Refund rate limit reached; this ticket is retried on the next run';
        }
      }
      else if (json?.status === 'refunded' || json?.status === 'already_refunded') result.refunded++;
      else result.pending++;
    } catch (e: any) {
      // A network failure: the server may or may not have acted. The ticket's
      // own state decides; the claim is retried only while it is still paid.
      message = e?.message || 'Network error';
    }
    if (message) {
      result.failed++; result.errors.push(message);
      await supabase.rpc('admin_record_event_cancellation_refund_error' as any, { p_request_id: id, p_ticket_id: ticket_id, p_error: message });
    }
  }
  return result;
}

/**
 * Re-queue a failed cancellation refund (Super Admin; 0219). The server
 * refuses unless the ticket is still paid, i.e. no refund is in flight.
 */
export async function adminRequeueCancellationRefund(id: string, ticketId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('admin_requeue_event_cancellation_refund' as any, { p_request_id: id, p_ticket_id: ticketId, p_note: note.trim() });
  if (error) rpcError(error, 'The refund could not be re-queued.');
}
