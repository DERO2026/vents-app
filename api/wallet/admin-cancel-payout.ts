import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Admin override for a withdrawal request stuck in 'processing' that
// doesn't actually exist on Paystack (a transfer_code that was never
// really created, or points to something Paystack no longer recognizes) —
// the reconciliation endpoint (reconcile-payouts.ts) can only resolve
// requests Paystack still knows about; this is the manual path for the
// ones it can't, so the held funds don't lock up the organizer's wallet
// forever.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { request_id, reason } = req.body || {};
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'A cancellation reason is required' });
  }

  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  try {
    // is_admin() check, the 'processing'-only guard, the status flip, the
    // wallet refund (balance_kobo += amount, pending_kobo -= amount), and
    // the organizer_transactions audit row all happen atomically inside
    // this single RPC call.
    const rpcRes = await fetch(`${baseUrl}/api/database/rpc/admin_cancel_processing_payout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        apikey: anonKey,
      },
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
    return res.status(500).json({ error: err?.message || 'Cancel payout failed' });
  }
}
