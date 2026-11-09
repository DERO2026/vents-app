// Paystack transfer helpers shared by payout approval, reconciliation and
// the webhook (see supabase/migrations/0202_payout_engine_safety.sql).
//
// Every withdrawal request has ONE fixed transfer reference for its whole
// life. Paystack refuses a second transfer with a reference it has already
// seen, so retrying an approval after a timeout can never pay twice.

/** Same value as public.payout_transfer_reference(uuid) in 0202. */
export function payoutTransferReference(requestId: string): string {
  return `payout_${requestId.replace(/-/g, '')}`;
}

export type TransferLookup =
  | { state: 'found'; transferCode: string | null; status: string; data: any }
  | { state: 'not_found' }
  | { state: 'unknown'; detail: string };

/**
 * Asks Paystack whether a transfer with this reference exists. Only an
 * explicit "not found" from Paystack counts as not found; a timeout, a
 * server error or an unreadable reply is 'unknown', and the caller must
 * then leave the request in 'processing' for Reconcile.
 */
export async function lookupTransferByReference(secret: string, reference: string): Promise<TransferLookup> {
  let res: Response;
  try {
    res = await fetch(`https://api.paystack.co/transfer/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
  } catch (err: any) {
    return { state: 'unknown', detail: err?.message || 'network error' };
  }
  const json: any = await res.json().catch(() => null);
  if (res.ok && json?.status === true && json.data) {
    return { state: 'found', transferCode: json.data.transfer_code ?? null, status: String(json.data.status || ''), data: json.data };
  }
  if (res.status === 404 || (res.status === 400 && /not\s*found/i.test(String(json?.message || '')))) {
    return { state: 'not_found' };
  }
  return { state: 'unknown', detail: json?.message || `HTTP ${res.status}` };
}

/** Paystack transfer statuses that end the request. */
export function finalTransferStatus(status: string): 'success' | 'failed' | 'reversed' | null {
  return status === 'success' || status === 'failed' || status === 'reversed' ? status : null;
}
