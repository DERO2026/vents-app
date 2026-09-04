// @ts-nocheck
// Vercel serverless function: POST /api/webhook/paystack
// Verifies Paystack webhook HMAC-SHA512 signature before processing.
// Set PAYSTACK_SECRET_KEY in Vercel environment variables.

import { sendPayoutDecisionEmail, sendTicketRefundEmail } from '../_lib/mailer.js';
import { callProjectAdminTableRpc } from '../_lib/projectAdminDb.js';
import { finalizeAndConfirmPurchase } from '../_lib/finalizePaystackPayment.js';
import crypto from 'crypto';

function fmtNaira(kobo) {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('PAYSTACK_SECRET_KEY not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-paystack-signature'] as string | undefined;
  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  // Vercel provides raw body as Buffer when Content-Type is application/json
  const rawBody = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  const signatureBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const valid = signatureBuf.length === expectedBuf.length && crypto.timingSafeEqual(signatureBuf, expectedBuf);
  if (!valid) {
    console.warn('Paystack webhook signature mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  console.log('Paystack webhook event:', event?.event);

  if (event?.event === 'charge.success') {
    const reference = event.data?.reference;
    const amountKobo = event.data?.amount;

    if (!reference || typeof amountKobo !== 'number') {
      console.error('[Paystack webhook] charge.success missing reference or amount', { reference, amountKobo });
      return res.status(200).json({ received: true });
    }

    try {
      // Recovery path: if the client was killed/crashed/lost network between
      // Paystack charging the card and its own verify call (api/payments/
      // verify.ts), this is what still gets the buyer a ticket — this is
      // the authoritative confirmation path (Paystack's own signed webhook
      // event, HMAC-verified above), not a fallback to it. Shared with
      // api/payments/verify.ts's client-triggered path via
      // finalizeAndConfirmPurchase so the two can never drift out of sync;
      // whichever runs first wins, the other no-ops against the same
      // locked rows.
      const result = await finalizeAndConfirmPurchase(reference, amountKobo);

      if (result.status === 'amount_mismatch') {
        console.error('[Paystack webhook] AMOUNT MISMATCH for reference', reference, '-', result.expectedKobo, 'vs', result.gotKobo);
      } else if (result.status === 'not_found') {
        console.warn('[Paystack webhook] No ticket found for reference', reference);
      } else if (result.status === 'already_paid') {
        console.log('[Paystack webhook] Ticket already paid, no-op for reference', reference);
      } else if (result.status === 'confirmed') {
        console.log('[Paystack webhook] Ticket confirmed for reference', reference);
      } else if (result.status === 'confirmed_lookup_failed') {
        // Payment is genuinely confirmed (payment_status='paid', wallet
        // credited) — only the ticket-id readback failed, which this path
        // doesn't even use. Logged for visibility, not an error condition.
        console.warn('[Paystack webhook] Ticket confirmed but id lookup failed for reference', reference);
      }
    } catch (err: any) {
      console.error('[Paystack webhook] Error calling confirm_ticket_payment:', err?.message || err);
    }
  }

  // ── Organizer payout transfer status ──────────────────────────────────
  // This is the authoritative completion signal for a payout — the
  // synchronous /transfer response only means "accepted for processing",
  // not "money actually moved" (some accounts require OTP finalization).
  if (event?.event === 'transfer.success' || event?.event === 'transfer.failed' || event?.event === 'transfer.reversed') {
    const transferCode = event.data?.transfer_code;
    const reference = event.data?.reference;
    const lookupKey = transferCode || reference;

    if (!lookupKey) {
      console.error('[Paystack webhook] transfer event missing transfer_code/reference', event.data);
      return res.status(200).json({ received: true });
    }

    try {
      // complete_organizer_payout/fail_organizer_payout have no internal
      // auth check of their own (they trust this webhook's HMAC verification
      // above, not RLS) and are project_admin-only (no anon/authenticated/
      // service_role EXECUTE grant) — called via the direct project_admin
      // Postgres connection, same as the ticket-confirmation block above
      // (see api/_lib/projectAdminDb.ts).
      const rpcName = event.event === 'transfer.success' ? 'complete_organizer_payout' : 'fail_organizer_payout';
      const rows = event.event === 'transfer.success'
        ? await callProjectAdminTableRpc<any>('complete_organizer_payout', [lookupKey])
        : await callProjectAdminTableRpc<any>('fail_organizer_payout', [lookupKey, event.data?.reason || event.event]);
      const row = rows[0];
      console.log(`[Paystack webhook] ${event.event} -> ${rpcName} result:`, row?.status, 'for', lookupKey);

      // Fire the payout email only on a genuine, first-time state change —
      // never on 'not_found'/'already_completed'/'already_finalized', which
      // would otherwise re-send on Paystack's webhook retries.
      if (row?.organizer_email && (row.status === 'completed' || row.status === 'failed')) {
        sendPayoutDecisionEmail({
          to: row.organizer_email,
          name: row.organizer_name || 'there',
          amountNaira: fmtNaira(Number(row.amount_kobo) || 0),
          decision: row.status,
          reason: row.status === 'failed' ? (event.data?.reason || 'Transfer could not be completed') : undefined,
        }).catch((e) => console.error('[Paystack webhook] payout email failed:', e?.message || e));
      }
    } catch (err: any) {
      console.error(`[Paystack webhook] Error handling ${event.event}:`, err?.message || err);
    }
  }

  // ── Ticket refund status ──────────────────────────────────────────────
  // Same reasoning as the transfer webhooks above: the synchronous /refund
  // create-call response only means "accepted", not "money moved" -- these
  // events are the authoritative completion signal.
  if (event?.event === 'refund.processed' || event?.event === 'refund.failed') {
    const refundId = event.data?.id != null ? String(event.data.id) : null;

    if (!refundId) {
      console.error('[Paystack webhook] refund event missing data.id', event.data);
      return res.status(200).json({ received: true });
    }

    try {
      // finalize_ticket_refund / fail_ticket_refund are keyed only on
      // Paystack's own numeric refund id (short, sequential, enumerable)
      // with no internal auth check — that id alone would be enough to
      // revert someone else's in-flight refund if these were reachable over
      // the normal REST surface, so (like the transfer.* handlers above)
      // EXECUTE is revoked from anon/authenticated/service_role and they're
      // only callable via the direct project_admin Postgres connection.
      if (event.event === 'refund.processed') {
        const rows = await callProjectAdminTableRpc<any>('finalize_ticket_refund', [refundId]);
        const row = rows[0];
        console.log('[Paystack webhook] refund.processed -> finalize_ticket_refund result:', row?.status, 'for', refundId);

        if (row?.status === 'finalized' && row?.buyer_email) {
          sendTicketRefundEmail({
            to: row.buyer_email,
            name: row.buyer_name || 'there',
            eventTitle: row.event_title || 'your event',
            ticketType: row.ticket_type || 'Regular',
            amountNaira: fmtNaira(Number(row.refunded_amount_kobo) || 0),
            reason: row.reason || 'Refund requested by the organizer.',
          }).catch((e) => console.error('[Paystack webhook] refund email failed:', e?.message || e));
        }
      } else {
        const rows = await callProjectAdminTableRpc<any>('fail_ticket_refund', [refundId, event.data?.message || event.event]);
        const row = rows[0];
        console.log('[Paystack webhook] refund.failed -> fail_ticket_refund result:', row?.status, 'for', refundId);
      }
    } catch (err: any) {
      console.error(`[Paystack webhook] Error handling ${event.event}:`, err?.message || err);
    }
  }

  // Always 200 so Paystack does not endlessly retry.
  return res.status(200).json({ received: true });
}
