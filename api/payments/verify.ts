// POST /api/payments/verify — the client-triggered half of payment
// completion, called after CheckoutScreen's Paystack popup reports success
// (or after returning from a redirect-based channel like bank
// transfer/USSD via the vents:// deep-link / ?paystack_ref= web fallback —
// see App.tsx). Deliberately does NOT trust that signal on its own:
// "the client called this" and "the client's popup callback fired" are
// both just "the browser thinks payment happened", not proof. The only
// real proof is Paystack's own GET /transaction/verify/:reference,
// called here server-side with the secret key (never sent to the client),
// exactly the same authority the webhook relies on via its HMAC-signed
// event — this is the second, client-triggered path to that same
// authoritative confirmation, for when the webhook is slow or the app
// closed before the popup's JS callback could fire (common for
// bank_transfer/ussd/mobile_money channels, which don't complete inside
// the iframe at all).
//
// finalize_pending_purchase/confirm_ticket_payment (the actual ticket-
// creation + payment_status='paid' + wallet-credit logic) are project_admin
// -only (supabase/migrations/0031_restrict_finalize_pending_purchase.sql)
// — this endpoint is now one of exactly two ways into that logic, the
// other being the webhook itself. A client can no longer create a working
// ticket by calling the old finalize RPC directly without ever paying.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';
import { callProjectAdminRpc } from '../_lib/projectAdminDb.js';
import { finalizeAndConfirmPurchase } from '../_lib/finalizePaystackPayment.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await verifyInsforgeSession(req.headers.authorization);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { reference } = req.body || {};
  if (!reference || typeof reference !== 'string') {
    return res.status(400).json({ error: 'reference is required' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('[payments/verify] PAYSTACK_SECRET_KEY not set');
    return res.status(500).json({ error: 'Payment verification not configured' });
  }

  try {
    // Ownership check: confirm the caller actually owns the pending
    // purchase this reference belongs to before spending a Paystack call or
    // finalizing anything on their say-so. A reference with no matching
    // pending_purchases row (already finalized in a prior call, or simply
    // unknown) isn't itself an error here — finalize_pending_purchase's own
    // idempotency and confirm_ticket_payment's ticket lookup below handle
    // that; this only blocks a caller asking about a reference that
    // demonstrably belongs to someone else.
    const ownerId = await callProjectAdminRpc<string | null>('get_pending_purchase_owner', [reference]);
    if (ownerId && ownerId !== session.userId) {
      return res.status(403).json({ error: 'Not authorized for this payment reference' });
    }

    const pRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const pJson = await pRes.json().catch(() => null);

    if (!pRes.ok || !pJson?.status) {
      return res.status(502).json({ status: 'error', error: pJson?.message || 'Could not reach Paystack to verify this payment.' });
    }

    const txStatus = pJson.data?.status; // 'success' | 'failed' | 'abandoned' | ...
    const amountKobo = pJson.data?.amount;

    if (txStatus !== 'success') {
      // Covers failed, abandoned, and cancelled payments alike — Paystack's
      // own transaction record is the source of truth for all three; none
      // of them ever reach finalizeAndConfirmPurchase, so no ticket is
      // ever created for a payment that didn't actually succeed.
      return res.status(200).json({ status: txStatus === 'abandoned' ? 'abandoned' : 'failed' });
    }

    if (typeof amountKobo !== 'number') {
      return res.status(502).json({ status: 'error', error: 'Paystack returned no amount for this transaction.' });
    }

    const result = await finalizeAndConfirmPurchase(reference, amountKobo);

    if (result.status === 'amount_mismatch') {
      console.error('[payments/verify] AMOUNT MISMATCH for reference', reference, '-', result.expectedKobo, 'vs', result.gotKobo);
      return res.status(200).json({ status: 'error', error: 'Payment amount did not match the expected order amount.' });
    }
    if (result.status === 'not_found') {
      return res.status(200).json({ status: 'error', error: 'No matching order was found for this payment.' });
    }
    if (result.status === 'confirmed_lookup_failed') {
      // Payment IS confirmed at this point (payment_status='paid', wallet
      // already credited) — only the ticket-id readback failed. Still
      // reported as status: 'success' (it genuinely is one) so the client
      // never shows a failure/refund-support message for a payment that
      // went through; ticketIds is empty and ticketLookupPending tells the
      // client to fall back to a Wallet refresh instead of expecting an
      // instant ticket_id/token.
      return res.status(200).json({ status: 'success', ticketIds: [], ticketLookupPending: true });
    }

    return res.status(200).json({ status: 'success', ticketIds: result.ticketIds });
  } catch (err: any) {
    console.error('[payments/verify] error:', err?.message || err);
    return res.status(500).json({ status: 'error', error: 'Payment verification failed. Please try again or contact support.' });
  }
}
