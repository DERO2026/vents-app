import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../_lib/cors.js';

// Organizer/admin-triggered ticket refund. refund_ticket (SECURITY DEFINER)
// does all the authorization, locking, and state transition inside
// Postgres; this endpoint's only job is the part a Postgres function can't
// do itself -- calling out to Paystack's refund API with the secret key --
// then recording the resulting refund id so the refund.processed /
// refund.failed webhook (api/webhook/paystack.ts) can find this ticket
// again and finalize it. Mirrors admin-approve-payout.ts's shape exactly:
// RPC (authorize + lock + return what's needed) -> Paystack call -> RPC
// (record the provider's reference) -> webhook finalizes later.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { ticket_id, reason } = req.body || {};
  if (!ticket_id || typeof ticket_id !== 'string') {
    return res.status(400).json({ error: 'ticket_id is required' });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'A refund reason is required' });
  }

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
    // is_admin()/organizer-of-event authorization, the paid-only guard, and
    // the flip to 'refund_pending' (or straight to 'refunded' for free
    // tickets with nothing to move) all happen atomically inside this RPC.
    const rpcRes = await fetch(`${baseUrl}/rest/v1/rpc/refund_ticket`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify({ p_ticket_id: ticket_id, p_reason: reason.trim() }),
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
      return res.status(502).json({ error: 'Unexpected refund_ticket response' });
    }

    // amount_kobo is already in kobo -- do NOT multiply by 100 again, that
    // would refund 100x the intended amount.
    const refundRes = await fetch('https://api.paystack.co/refund', {
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
    });
    const refundJson = await refundRes.json().catch(() => null);
    const refundId = refundJson?.data?.id != null ? String(refundJson.data.id) : null;

    if (!refundRes.ok || !refundJson?.status || !refundId) {
      // Paystack rejected the refund outright (invalid/unknown transaction,
      // insufficient balance, already fully refunded on their side, etc) --
      // release the ticket back to 'paid' rather than leaving it stuck
      // showing cancelled with no refund actually in flight.
      await fetch(`${baseUrl}/rest/v1/rpc/admin_revert_stuck_refund`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({
          p_ticket_id: ticket_id,
          p_reason: 'Paystack refund creation failed: ' + (refundJson?.message || `HTTP ${refundRes.status}`),
        }),
      }).catch(() => {});
      return res.status(502).json({ error: refundJson?.message || 'Paystack refund initiation failed' });
    }

    await fetch(`${baseUrl}/rest/v1/rpc/attach_ticket_refund_id`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify({ p_ticket_id: ticket_id, p_refund_id: refundId }),
    });

    // Paystack has accepted the refund for processing -- refund.processed /
    // refund.failed webhooks are the authoritative "money actually moved"
    // signal (same pattern as organizer payout transfers), not this response.
    return res.status(200).json({ status: 'refund_pending', refund_id: refundId });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Refund failed' });
  }
}
