import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../_lib/cors.js';
import { refuseInPreview } from '../_lib/previewGuard.js';

// Organizer/admin-triggered ticket refund, and provider/admin-triggered
// service-booking refund -- refund_ticket / cancel_service_booking
// (both SECURITY DEFINER) do all the authorization, locking, and state
// transition inside Postgres; this endpoint's only job is the part a
// Postgres function can't do itself -- calling out to Paystack's refund
// API with the secret key -- then recording the resulting refund id so the
// refund.processed/refund.failed webhook (api/webhook/paystack.ts) can
// find the ticket/booking again and finalize it. Mirrors
// admin-approve-payout.ts's shape exactly: RPC (authorize + lock + return
// what's needed) -> Paystack call -> RPC (record the provider's reference)
// -> webhook finalizes later.
//
// Handles both ticket_id and booking_id in one file (not two) because
// Vercel's Hobby plan caps this project at 12 serverless functions -- see
// api/webhook/paystack.ts's ?action= dispatch for the same constraint.
// Kept below the shortest Vercel function limit (10 s), so an unanswered
// Paystack call is reported as unconfirmed instead of the function being
// killed mid-request.
const PAYSTACK_REFUND_TIMEOUT_MS = 8000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (refuseInPreview(res, 'ticket refund')) return;

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { ticket_id, booking_id, reason } = req.body || {};
  if (ticket_id && booking_id) {
    return res.status(400).json({ error: 'Pass either ticket_id or booking_id, not both' });
  }
  if (!ticket_id && !booking_id) {
    return res.status(400).json({ error: 'ticket_id or booking_id is required' });
  }
  if (ticket_id && typeof ticket_id !== 'string') {
    return res.status(400).json({ error: 'ticket_id is required' });
  }
  if (booking_id && typeof booking_id !== 'string') {
    return res.status(400).json({ error: 'booking_id is required' });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'A refund reason is required' });
  }

  const isBooking = !!booking_id;
  const entityId = isBooking ? booking_id : ticket_id;
  const rpcNames = isBooking
    ? {
        start: 'cancel_service_booking',
        attach: 'attach_service_booking_refund_id',
        revert: 'admin_revert_stuck_service_refund',
      }
    : {
        start: 'refund_ticket',
        attach: 'attach_ticket_refund_id',
        revert: 'admin_revert_stuck_refund',
      };
  const idParam = isBooking ? 'p_booking_id' : 'p_ticket_id';

  const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!paystackSecret || !baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Refund system not configured' });
  }

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    apikey: anonKey,
  };

  try {
    // is_admin()/organizer-of-event (or provider-of-booking) authorization,
    // the paid-only guard, and the flip to 'refund_pending' (or straight to
    // 'refunded' for a free ticket/zero-amount booking with nothing to
    // move) all happen atomically inside this RPC.
    const rpcRes = await fetch(`${baseUrl}/rest/v1/rpc/${rpcNames.start}`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify({ [idParam]: entityId, p_reason: reason.trim() }),
    });
    if (!rpcRes.ok) {
      const errJson = await rpcRes.json().catch(() => null);
      return res.status(rpcRes.status).json({ error: errJson?.message || 'Refund could not be started' });
    }

    const raw = await rpcRes.json().catch(() => null);
    const state = raw?.data ?? raw;

    if (state?.status === 'refunded' || state?.status === 'already_refunded') {
      // Free ticket, or a repeat call after it already finished.
      return res.status(200).json({ status: state.status });
    }

    if (state?.status !== 'refund_pending' || !state?.payment_ref || !state?.amount_kobo) {
      return res.status(502).json({ error: `Unexpected ${rpcNames.start} response` });
    }

    // Paystack financial-exposure audit finding: no global ceiling existed
    // on aggregate Paystack /refund volume across all authorized callers
    // combined. Checked here, AFTER authorization/state validation above
    // (the request is only rate-limited once it's a genuine, authorized,
    // refund_pending case -- an unauthorized or ineligible call never
    // reaches this check at all, so it can't consume refund capacity) and
    // strictly BEFORE the Paystack call below. Fails CLOSED like every
    // other global check added this engagement: a genuine limit hit or an
    // RPC/infra failure both block the Paystack call. The RPC above already
    // flipped this ticket/booking to 'refund_pending' -- a rejection here
    // must release that claim (same revert path already used below for a
    // Paystack-rejected refund) rather than leave it stranded with no
    // provider attempt ever made.
    try {
      const { callProjectAdminRpc } = await import('../_lib/projectAdminDb.js');
      await callProjectAdminRpc('check_rate_limit', ['paystack_refund_global', 100, 3600]);
    } catch {
      await fetch(`${baseUrl}/rest/v1/rpc/${rpcNames.revert}`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({ [idParam]: entityId, p_reason: 'Too many refund requests right now. Please try again in a bit.' }),
      }).catch(() => {});
      return res.status(429).json({ error: 'Too many requests. Please try again in a bit.' });
    }

    // amount_kobo is already in kobo -- do NOT multiply by 100 again, that
    // would refund 100x the intended amount.
    //
    // Only a DEFINITIVE rejection may release the claim. A released ticket is
    // 'paid' again and can be refunded again (event cancellations retry it
    // automatically), so treating an uncertain outcome as a rejection risks a
    // second refund for one ticket -- for a multi-ticket payment, a second
    // partial refund Paystack would accept. Uncertain = no answer in time,
    // a network error, a 5xx, or a success-shaped answer without a refund id:
    // the refund may exist at Paystack. Those stay 'refund_pending' with no
    // refund id (shown as unconfirmed) until someone checks Paystack.
    let refundRes: Response | null = null;
    let refundJson: any = null;
    let uncertain: string | null = null;
    try {
      refundRes = await fetch('https://api.paystack.co/refund', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transaction: state.payment_ref,
          amount: state.amount_kobo,
          merchant_note: reason.trim(),
        }),
        signal: AbortSignal.timeout(PAYSTACK_REFUND_TIMEOUT_MS),
      });
      refundJson = await refundRes.json().catch(() => null);
    } catch (e: any) {
      uncertain = e?.name === 'TimeoutError' ? 'no answer from Paystack in time' : `network error (${e?.message || 'unknown'})`;
    }
    const refundId = refundJson?.data?.id != null ? String(refundJson.data.id) : null;

    if (!uncertain && refundRes && !(refundRes.ok && refundJson?.status && refundId)) {
      const definitive = refundRes.status >= 400 && refundRes.status < 500 && refundJson?.status === false;
      if (!definitive) uncertain = `unclear Paystack answer (HTTP ${refundRes.status})`;
    }
    if (uncertain) {
      console.error('[refund-ticket] REFUND UNCONFIRMED: check Paystack before reverting.', rpcNames.start, entityId,
        'transaction', state.payment_ref, 'amount_kobo', state.amount_kobo, '-', uncertain);
      return res.status(502).json({
        error: `Paystack did not confirm this refund (${uncertain}). It is held as unconfirmed: check Paystack before retrying or reverting it.`,
        unconfirmed: true,
      });
    }

    if (!refundRes!.ok || !refundJson?.status || !refundId) {
      // Paystack rejected the refund outright (4xx with status:false --
      // invalid/unknown transaction, insufficient balance, already fully
      // refunded on their side, etc) -- release the ticket back to 'paid'
      // rather than leaving it stuck showing cancelled with no refund in flight.
      await fetch(`${baseUrl}/rest/v1/rpc/${rpcNames.revert}`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({
          [idParam]: entityId,
          p_reason: 'Paystack refund creation failed: ' + (refundJson?.message || `HTTP ${refundRes!.status}`),
        }),
      }).catch(() => {});
      return res.status(502).json({ error: refundJson?.message || 'Paystack refund initiation failed' });
    }

    // The webhook finds the ticket/booking only by this refund id, so a lost
    // attach leaves an accepted refund unmatched. Retry once, then say so
    // loudly with the id needed to reconcile it by hand.
    let attached = false;
    for (let i = 0; i < 2 && !attached; i++) {
      const attachRes = await fetch(`${baseUrl}/rest/v1/rpc/${rpcNames.attach}`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({ [idParam]: entityId, p_refund_id: refundId }),
      }).catch(() => null);
      attached = !!attachRes?.ok;
    }
    if (!attached) {
      console.error('[refund-ticket] REFUND ID NOT RECORDED: Paystack accepted refund', refundId, 'for', rpcNames.start, entityId,
        '- attach it by hand or the refund webhook cannot match it.');
      return res.status(202).json({ status: 'refund_pending', refund_id: refundId, refund_id_recorded: false });
    }

    // Paystack has accepted the refund for processing -- refund.processed /
    // refund.failed webhooks are the authoritative "money actually moved"
    // signal (same pattern as organizer payout transfers), not this response.
    return res.status(200).json({ status: 'refund_pending', refund_id: refundId });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Refund failed' });
  }
}
