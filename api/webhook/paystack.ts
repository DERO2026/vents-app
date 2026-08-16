// @ts-nocheck
// Vercel serverless function: POST /api/webhook/paystack
// Verifies Paystack webhook HMAC-SHA512 signature before processing.
// Set PAYSTACK_SECRET_KEY in Vercel environment variables.

import { sendPayoutDecisionEmail, sendTicketRefundEmail } from '../_lib/mailer.js';
import { callProjectAdminRpc, callProjectAdminTableRpc } from '../_lib/projectAdminDb.js';
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
      // Paystack charging the card and its own finalize_pending_purchase
      // call, confirm_ticket_payment below would find no ticket row at all
      // (it only ever UPDATEs existing rows) and the buyer would be charged
      // with no way to get a ticket. finalize_pending_purchase creates the
      // ticket from the payment intent persisted by create_pending_purchase
      // BEFORE the Paystack popup ever opened (CheckoutScreen.tsx) — it's
      // idempotent (locks the pending_purchases row FOR UPDATE, no-ops if
      // already completed), so calling it here is always safe whether or
      // not the client already got to it. A reference that never went
      // through create_pending_purchase (e.g. a free ticket, which never
      // touches Paystack or this webhook, or some other legacy path) simply
      // has no pending_purchases row — this RAISEs "not found" (confirmed
      // live), caught and logged as the expected, non-fatal no-op below;
      // confirm_ticket_payment still runs regardless.
      try {
        await callProjectAdminRpc('finalize_pending_purchase', [reference]);
        console.log('[Paystack webhook] finalize_pending_purchase ran for reference', reference);
      } catch (finalizeErr: any) {
        console.warn('[Paystack webhook] finalize_pending_purchase no-op/failed for', reference, '-', finalizeErr?.message || finalizeErr);
      }

      // confirm_ticket_payment is SECURITY DEFINER and does the whole thing
      // atomically: look up the ticket by payment_ref, verify the webhook's
      // amount (kobo) exactly matches the ticket's stored amount, no-op if
      // already paid, otherwise mark paid + credit organizer wallet + notify.
      const status = await callProjectAdminRpc<string>('confirm_ticket_payment', [reference, amountKobo]);

      if (typeof status === 'string' && status.startsWith('amount_mismatch')) {
        console.error('[Paystack webhook] AMOUNT MISMATCH for reference', reference, '-', status);
      } else if (status === 'not_found') {
        console.warn('[Paystack webhook] No ticket found for reference', reference);
      } else if (status === 'already_paid') {
        console.log('[Paystack webhook] Ticket already paid, no-op for reference', reference);
      } else if (status === 'confirmed') {
        console.log('[Paystack webhook] Ticket confirmed for reference', reference);
      } else {
        console.warn('[Paystack webhook] Unexpected confirm_ticket_payment result', status);
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
