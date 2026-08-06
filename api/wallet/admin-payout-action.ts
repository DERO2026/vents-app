import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Combines the three admin payout actions (approve a pending request,
// reject a still-pending one, cancel one stuck in 'processing') into one
// endpoint via an `action` discriminator — folded together to stay under
// the Vercel Hobby-plan 12-serverless-function cap, same pattern already
// used elsewhere in this codebase (api/notify/status-email.ts's
// request_type). 'approve' was originally its own file
// (admin-approve-payout.ts) — merged in here, verbatim logic, when adding
// the FCM push cron endpoints pushed the project over the function cap.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { action, request_id, reason } = req.body || {};
  if (action !== 'reject' && action !== 'cancel' && action !== 'approve') {
    return res.status(400).json({ error: 'action must be "approve", "reject" or "cancel"' });
  }
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (action !== 'approve' && (!reason || typeof reason !== 'string' || !reason.trim())) {
    return res.status(400).json({ error: `A ${action === 'reject' ? 'rejection' : 'cancellation'} reason is required` });
  }

  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  const insforgeHeaders = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    apikey: anonKey,
  };

  try {
    if (action === 'approve') {
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        return res.status(500).json({ error: 'Payout system not configured' });
      }

      // is_admin() is enforced inside this RPC. Critically, this ATOMICALLY
      // flips the request from 'pending' to 'processing' (a compare-and-swap
      // UPDATE ... WHERE status = 'pending') BEFORE we ever touch Paystack —
      // this is what makes concurrent approvals of the same request safe:
      // only the caller whose UPDATE actually matched the row
      // (claimed === true) proceeds to fire a real transfer. A second,
      // concurrent/duplicate call for the same request_id gets
      // claimed === false and stops here.
      const fetchRes = await fetch(`${baseUrl}/api/database/rpc/admin_claim_payout_for_processing`, {
        method: 'POST',
        headers: insforgeHeaders,
        body: JSON.stringify({ p_request_id: request_id }),
      });
      if (!fetchRes.ok) {
        const errJson = await fetchRes.json().catch(() => null);
        return res.status(fetchRes.status).json({ error: errJson?.message || 'Admin access required' });
      }
      const claimRows = await fetchRes.json();
      const claimRow = Array.isArray(claimRows) ? claimRows[0] : claimRows;
      if (!claimRow) return res.status(404).json({ error: 'Payout request not found' });
      if (!claimRow.claimed) {
        return res.status(409).json({ error: `Request is already ${claimRow.status}, not pending` });
      }
      if (!claimRow.recipient_code) {
        // We already claimed (flipped to 'processing') above — release it
        // back to 'pending' rather than leaving it stuck with no transfer
        // in flight.
        await fetch(`${baseUrl}/api/database/rpc/admin_release_payout_claim`, {
          method: 'POST',
          headers: insforgeHeaders,
          body: JSON.stringify({ p_request_id: request_id, p_reason: 'No verified bank account on file' }),
        }).catch(() => {});
        return res.status(422).json({ error: 'Organizer has no verified bank account on file' });
      }

      const reference = `payout_${request_id}_${Date.now()}`;

      // amount_kobo is already in kobo — do NOT multiply by 100 again, that
      // would send 100x the intended amount.
      const transferRes = await fetch('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'balance',
          amount: claimRow.amount_kobo,
          recipient: claimRow.recipient_code,
          reason: 'Vents organizer payout',
          reference,
        }),
      });
      const transferJson = await transferRes.json();

      if (!transferRes.ok || !transferJson.status) {
        // Paystack rejected the transfer outright — release the claim back
        // to 'pending' (guarded server-side to only work when no
        // transfer_code was ever attached) so the admin can safely retry.
        await fetch(`${baseUrl}/api/database/rpc/admin_release_payout_claim`, {
          method: 'POST',
          headers: insforgeHeaders,
          body: JSON.stringify({ p_request_id: request_id, p_reason: 'Paystack transfer initiation failed: ' + (transferJson.message || `HTTP ${transferRes.status}`) }),
        }).catch(() => {});
        return res.status(502).json({ error: transferJson.message || 'Paystack transfer initiation failed' });
      }

      // Paystack accepted the transfer. The request is already 'processing'
      // (claimed atomically above) — this just attaches the reference.
      // Depending on the account's OTP settings this may still require
      // finalization on Paystack's side — transfer.success / transfer.failed
      // webhooks are the authoritative completion signal (see
      // api/webhook/paystack.ts), not this response.
      await fetch(`${baseUrl}/api/database/rpc/admin_mark_payout_processing`, {
        method: 'POST',
        headers: insforgeHeaders,
        body: JSON.stringify({
          p_request_id: request_id,
          p_paystack_reference: reference,
          p_transfer_code: transferJson.data?.transfer_code || null,
        }),
      });

      return res.status(200).json({ status: 'processing', reference, transfer_code: transferJson.data?.transfer_code });
    }

    if (action === 'reject') {
      // is_admin() + funds rollback (pending_kobo -> balance_kobo) both
      // happen atomically inside this RPC. Reject is for a still-pending
      // request; the client fires its own decision email separately.
      const rpcRes = await fetch(`${baseUrl}/api/database/rpc/admin_reject_organizer_payout`, {
        method: 'POST',
        headers: insforgeHeaders,
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
    const rpcRes = await fetch(`${baseUrl}/api/database/rpc/admin_cancel_processing_payout`, {
      method: 'POST',
      headers: insforgeHeaders,
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
