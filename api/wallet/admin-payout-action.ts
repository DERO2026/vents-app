import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Combines the two admin payout-decline actions (reject a still-pending
// request, cancel one stuck in 'processing') into one endpoint via an
// `action` discriminator — folded together to stay under the Vercel
// Hobby-plan 12-serverless-function cap, same pattern already used
// elsewhere in this codebase (api/notify/status-email.ts's request_type).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { action, request_id, reason } = req.body || {};
  if (action !== 'reject' && action !== 'cancel') {
    return res.status(400).json({ error: 'action must be "reject" or "cancel"' });
  }
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: `A ${action === 'reject' ? 'rejection' : 'cancellation'} reason is required` });
  }

  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  // admin_reject_organizer_payout/admin_cancel_processing_payout are both
  // EXECUTE-granted to `authenticated` (is_admin() checked internally) —
  // forwarding the caller's own Supabase session token.
  const supabaseHeaders = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    apikey: anonKey,
  };

  try {
    if (action === 'reject') {
      // is_admin() + funds rollback (pending_kobo -> balance_kobo) both
      // happen atomically inside this RPC. Reject is for a still-pending
      // request; the client fires its own decision email separately.
      const rpcRes = await fetch(`${baseUrl}/rest/v1/rpc/admin_reject_organizer_payout`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({ p_request_id: request_id, p_reason: reason.trim() }),
      });
      if (!rpcRes.ok) {
        const errJson = await rpcRes.json().catch(() => null);
        return res.status(rpcRes.status).json({ error: errJson?.message || 'Could not reject request' });
      }
      return res.status(200).json({ status: 'rejected' });
    }

    // action === 'cancel' — admin override for a withdrawal request stuck in
    // 'processing' that doesn't actually exist on Paystack (a transfer_code
    // that was never really created, or points to something Paystack no
    // longer recognizes). reconcile-payouts.ts can only resolve requests
    // Paystack still knows about; this is the manual path for the ones it
    // can't, so held funds don't lock up the organizer's wallet forever.
    // is_admin() check, the 'processing'-only guard, the status flip, the
    // wallet refund, and the organizer_transactions audit row all happen
    // atomically inside this single RPC call.
    const rpcRes = await fetch(`${baseUrl}/rest/v1/rpc/admin_cancel_processing_payout`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify({ p_request_id: request_id, p_reason: reason.trim() }),
    });
    if (!rpcRes.ok) {
      const errJson = await rpcRes.json().catch(() => null);
      return res.status(rpcRes.status).json({ error: errJson?.message || 'Could not cancel request' });
    }

    const rows = await rpcRes.json().catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row?.organizer_email) {
      sendPayoutDecisionEmail({
        to: row.organizer_email,
        name: row.organizer_name || 'there',
        amountNaira: fmtNaira(Number(row.amount_kobo) || 0),
        decision: 'failed',
        reason: reason.trim(),
      }).catch(() => {});
    }

    return res.status(200).json({ status: 'cancelled' });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Payout action failed' });
  }
}
