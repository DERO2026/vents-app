// ── Ticket validation (backend communication layer) ─────────────────────────
// The ONE place that talks to the VENTS backend for check-in. Preserves the
// existing server-authoritative flow: the signed v2 pass string scanned from
// the QR is handed verbatim to the `verify_entry_pass` RPC, which performs all
// cryptographic verification, event-ownership checks, and the atomic check-in
// write. The client never trusts or parses the token itself — it only presents
// the RPC's verdict. Kept deliberately free of any React/UI concerns so it can
// be unit-exercised and reused.

import { supabase } from '../../../lib/supabase';

export type ScanStatus = 'valid' | 'already_scanned' | 'denied' | 'offline';

export interface ScanOutcome {
  status: ScanStatus;
  headline: string;
  holderName?: string;
  ticketType?: string;
  eventName?: string;
  checkinTime?: string;   // localized time string, ready to display
  errorMsg?: string;
  originalScannerId?: string;
}

// Reject the verify promise if the backend hangs, so a slow/dead network can
// never freeze the scanning loop in its "verifying" state.
const VERIFY_TIMEOUT_MS = 9000;

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p), // the PostgREST builder is a thenable, not a real Promise
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('verify_timeout')), ms)),
  ]);
}

// Map a verify_entry_pass denial reason into an exact, glanceable headline +
// detail. Server messages/reasons are unchanged; this only presents them.
function deniedInfo(result: any): { headline: string; detail: string } {
  const reason = result?.reason as string | undefined;
  const msg = (result?.message as string | undefined) || '';
  const low = msg.toLowerCase();
  switch (reason) {
    case 'expired':
      return { headline: 'EXPIRED TICKET', detail: msg || 'This pass has expired.' };
    case 'wrong_organizer':
    case 'payload_mismatch':
      return { headline: 'WRONG EVENT', detail: msg || 'This ticket is for a different event.' };
    case 'not_active':
      if (low.includes('refund')) return { headline: 'REFUNDED', detail: 'This ticket was refunded.' };
      if (low.includes('cancel')) return { headline: 'CANCELLED', detail: 'This ticket was cancelled.' };
      return { headline: 'INVALID TICKET', detail: msg || 'This ticket is not active.' };
    case 'invalid_signature':
    case 'invalid_token':
    case 'unsigned_ticket':
    case 'legacy_token':
    case 'not_found':
      return { headline: 'INVALID TICKET', detail: msg || 'This ticket could not be validated.' };
    default:
      return { headline: 'ENTRY DENIED', detail: msg || 'This ticket could not be validated.' };
  }
}

function fmtTime(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  try {
    return new Date(iso).toLocaleTimeString('en-NG', { timeStyle: 'short' });
  } catch {
    return undefined;
  }
}

/**
 * Validate a scanned ticket token against the backend and return a
 * display-ready outcome. Never throws — network/timeout failures resolve to a
 * `denied` outcome with an actionable message so the caller's loop keeps moving.
 */
export async function validateTicket(
  rawTicketId: string,
  actorId: string,
  eventName?: string,
): Promise<ScanOutcome> {
  const ticketId = rawTicketId.trim();
  try {
    const { data, error } = (await withTimeout(
      supabase.rpc('verify_entry_pass' as any, {
        p_ticket_id: ticketId,
        p_actor_id: actorId,
      }),
      VERIFY_TIMEOUT_MS,
    )) as any;

    if (error) throw error;
    const result = data as any;

    if (result?.ok) {
      return {
        status: 'valid',
        headline: 'CHECKED IN',
        holderName: result.holder_name || 'Verified Attendee',
        ticketType: result.ticket_type || undefined,
        eventName: result.event_name || eventName,
        checkinTime: fmtTime(result.checked_in_at),
      };
    }

    if (result?.reason === 'already_scanned') {
      const t = fmtTime(result.checked_in_at);
      return {
        status: 'already_scanned',
        headline: 'ALREADY CHECKED IN',
        holderName: result.holder_name || undefined,
        ticketType: result.ticket_type || undefined,
        eventName: result.event_name || eventName,
        errorMsg: t ? `First scanned at ${t}` : 'This ticket was already scanned.',
        checkinTime: t,
        originalScannerId: result.scanner_id || undefined,
      };
    }

    const info = deniedInfo(result);
    return { status: 'denied', headline: info.headline, errorMsg: info.detail };
  } catch (err: any) {
    const raw = String(err?.message || '');
    if (/verify_timeout/.test(raw)) {
      return { status: 'offline', headline: 'CONNECTION SLOW', errorMsg: 'Network is slow — try again.' };
    }
    if (raw.includes('rate_limited')) {
      return { status: 'denied', headline: 'SLOW DOWN', errorMsg: 'Scanning too fast — pause a moment and try again.' };
    }
    // A network-layer failure (dropped Wi-Fi, DNS hiccup, offline) throws a
    // generic fetch/TypeError, not a structured server response describing
    // a real denial reason. Rendering that identically to "ENTRY DENIED"
    // makes a legitimate ticket and a forged one look the same at the
    // door — the one thing a door staffer must never be told incorrectly.
    // This also stops the raw error string (which could be a stack-trace-
    // shaped message) from leaking onto the scan screen.
    const isNetworkError = /failed to fetch|networkerror|network request failed|load failed|internet|err_network/i.test(raw)
      || err?.name === 'TypeError';
    if (isNetworkError) {
      return { status: 'offline', headline: 'OFFLINE — RETRY', errorMsg: 'No connection. Check your network and scan again.' };
    }
    return { status: 'denied', headline: 'ENTRY DENIED', errorMsg: raw || 'Could not verify. Try again.' };
  }
}
