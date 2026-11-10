import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { callProjectAdminRpc } from '../_lib/projectAdminDb.js';
import { refuseInPreview } from '../_lib/previewGuard.js';
import { payoutTransferReference, lookupTransferByReference } from '../_lib/paystackTransfers.js';

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
  if (refuseInPreview(res, 'payout action')) return;

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { action, request_id, reason, amount_kobo, pin, idempotency_key } = req.body || {};
  // 0213: 'approve' (claim + pay with no PIN) is gone. Paying is
  // 'authorize_pay': the VENTS Admin's 10-digit Admin Payout PIN, verified
  // by the database in the same transaction that claims this one request.
  if (action === 'approve') {
    return res.status(410).json({ error: 'Payouts now need the VENTS Admin: approve the withdrawal, then Authorize & Pay with the 10-digit Admin Payout PIN.' });
  }
  if (action !== 'reject' && action !== 'cancel' && action !== 'authorize_pay') {
    return res.status(400).json({ error: 'action must be "authorize_pay", "reject" or "cancel"' });
  }
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (action !== 'authorize_pay' && (!reason || typeof reason !== 'string' || !reason.trim())) {
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
    if (action === 'authorize_pay') {
      // Shape checks only; the database decides (and counts wrong PINs).
      // The PIN is never logged, echoed or stored here.
      if (typeof pin !== 'string' || !/^\d{10}$/.test(pin)) {
        return res.status(400).json({ error: 'Enter the 10-digit Admin Payout PIN', code: 'pin_format' });
      }
      if (!Number.isSafeInteger(amount_kobo) || amount_kobo <= 0) {
        return res.status(400).json({ error: 'amount_kobo (the amount you reviewed) is required' });
      }
      if (typeof idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotency_key)) {
        return res.status(400).json({ error: 'idempotency_key is required' });
      }
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        return res.status(500).json({ error: 'Payout system not configured' });
      }

      // Paystack payout audit finding: approving a payout is single-admin-
      // gated (is_admin() allows role 'admin' or 'sub-admin') with no
      // pacing safeguard of its own -- the atomic claim below is the
      // authoritative duplicate-transfer protection, but nothing stopped
      // one admin session from approving many DIFFERENT, individually
      // legitimate requests in rapid succession (a mis-click loop, or a
      // compromised/scripted session). This is a defense-in-depth ceiling
      // on APPROVAL RATE, not a duplicate-transfer fix -- that's already
      // handled by admin_claim_payout_for_processing's compare-and-swap.
      //
      // Keyed per admin (auth.uid() of the APPROVER, not the organizer being
      // paid), 20/hour: generous enough for a legitimate bulk payout day
      // (one approval every ~3 minutes sustained for an hour) while still
      // bounding a runaway approval loop. Calls check_rate_limit directly
      // over the trusted project_admin connection (same as
      // ticketResendRateLimit.security.test.ts / resolveAccountRateLimit.
      // security.test.ts) rather than enforceRateLimit, because this sits
      // directly in front of a real transfer and must fail CLOSED: ANY
      // error here (a genuine rate-limit hit OR an infra/RPC failure) blocks
      // the approval before admin_claim_payout_for_processing is ever
      // called, so a rejected check can never reach Paystack.
      const approverSession = await verifyInsforgeSession(authHeader);
      if (!approverSession) return res.status(401).json({ error: 'Not authenticated' });
      try {
        await callProjectAdminRpc('check_rate_limit', [`payout_approve:${approverSession.userId}`, 20, 3600]);
        // Financial-exposure audit finding: the per-admin limit above caps
        // one admin's own approval rate, but nothing capped AGGREGATE
        // approval volume across all admins combined. Checked here, still
        // before admin_claim_payout_for_processing and the Paystack
        // transfer below -- purely an additional cost/volume ceiling, not
        // a replacement for the per-admin limit or the atomic claim's own
        // duplicate-transfer protection. Fails CLOSED like the check above.
        await callProjectAdminRpc('check_rate_limit', ['payout_approve_global', 100, 3600]);
      } catch {
        return res.status(429).json({ error: 'Too many payout approvals. Please wait before approving more.' });
      }

      // 0213: the VENTS Admin's PIN is checked and the request claimed
      // ('pending' -> 'processing') in ONE database transaction, bound to
      // this request, amount, bank account and recipient. Only a call that
      // claimed it (claimed === true) goes on to Paystack; a retry with the
      // same idempotency key, a concurrent click, or a request already in
      // processing gets claimed === false and stops here.
      const fetchRes = await fetch(`${baseUrl}/rest/v1/rpc/admin_authorize_and_claim_payout`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({ p_request_id: request_id, p_amount_kobo: amount_kobo, p_pin: pin, p_idempotency_key: idempotency_key }),
      });
      if (!fetchRes.ok) {
        const errJson = await fetchRes.json().catch(() => null);
        return res.status(fetchRes.status).json({ error: errJson?.message || 'VENTS Admin access required' });
      }
      const claimRaw = await fetchRes.json().catch(() => null);
      const claimRow = Array.isArray(claimRaw) ? claimRaw[0] : claimRaw;
      if (!claimRow || typeof claimRow !== 'object') return res.status(502).json({ error: 'Unexpected response from the payout authorization' });
      if (claimRow.ok !== true) {
        const status = claimRow.code === 'wrong_pin' ? 401 : claimRow.code === 'pin_locked' || claimRow.code === 'pin_reset_required' ? 423 : 409;
        return res.status(status).json({ error: claimRow.message || 'Payout not authorized', code: claimRow.code, attempts_left: claimRow.attempts_left });
      }
      if (!claimRow.claimed) {
        return res.status(409).json({ error: `Already authorized: this withdrawal is ${claimRow.status}. No second transfer was sent.`, code: 'replayed', status: claimRow.status, reference: claimRow.reference });
      }
      if (!claimRow.recipient_code) {
        await fetch(`${baseUrl}/rest/v1/rpc/admin_release_payout_claim`, {
          method: 'POST',
          headers: supabaseHeaders,
          body: JSON.stringify({ p_request_id: request_id, p_reason: 'No verified bank account on file' }),
        }).catch(() => {});
        return res.status(422).json({ error: 'Organizer has no verified bank account on file' });
      }

      // One fixed reference per request (set by the claim above, 0202), so a
      // retry after a timeout reuses it and Paystack refuses a second transfer.
      const reference = payoutTransferReference(request_id);
      const release = (why: string) => fetch(`${baseUrl}/rest/v1/rpc/admin_release_payout_claim`, {
        method: 'POST',
        headers: supabaseHeaders,
        body: JSON.stringify({ p_request_id: request_id, p_reason: why }),
      }).catch(() => {});
      const markSent = async (transferCode: string | null) => {
        const r = await fetch(`${baseUrl}/rest/v1/rpc/admin_mark_payout_processing`, {
          method: 'POST',
          headers: supabaseHeaders,
          body: JSON.stringify({ p_request_id: request_id, p_paystack_reference: reference, p_transfer_code: transferCode }),
        });
        return r.ok;
      };
      const unknownOutcome = (detail: string) => res.status(502).json({
        status: 'processing',
        reference,
        error: `Paystack has not confirmed this transfer (${detail}). Nothing has been marked paid. Run Reconcile before doing anything else with this request.`,
      });

      // amount_kobo is already in kobo — do NOT multiply by 100 again, that
      // would send 100x the intended amount.
      let transferRes: Response | null = null;
      let transferJson: any = null;
      try {
        transferRes = await fetch('https://api.paystack.co/transfer', {
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
        transferJson = await transferRes.json().catch(() => null);
      } catch {
        transferRes = null;
      }

      if (transferRes?.ok && transferJson?.status) {
        // Accepted, not paid: transfer.success / transfer.failed / transfer.reversed
        // webhooks (or Reconcile) decide the outcome.
        if (!(await markSent(transferJson.data?.transfer_code || null))) {
          return unknownOutcome('the transfer was accepted but could not be recorded');
        }
        return res.status(200).json({ status: 'processing', reference, transfer_code: transferJson.data?.transfer_code });
      }

      // Rejected, timed out or unreadable: ask Paystack whether this
      // reference exists before touching the request.
      const lookup = await lookupTransferByReference(secret, reference);
      if (lookup.state === 'found') {
        if (!(await markSent(lookup.transferCode))) {
          return unknownOutcome('a transfer exists but could not be recorded');
        }
        return res.status(200).json({ status: 'processing', reference, transfer_code: lookup.transferCode });
      }
      if (lookup.state === 'not_found') {
        // Paystack confirms nothing was sent: safe to put the request back.
        await release('Paystack transfer initiation failed: ' + (transferJson?.message || (transferRes ? `HTTP ${transferRes.status}` : 'no response')));
        return res.status(502).json({ error: transferJson?.message || 'Paystack transfer initiation failed' });
      }
      return unknownOutcome(lookup.detail);
    }

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
