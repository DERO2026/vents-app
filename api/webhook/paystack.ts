// @ts-nocheck
// Vercel serverless function, two entry points sharing one file to stay
// under the Hobby plan's 12-Serverless-Functions-per-deployment cap (this
// repo was already at exactly 12; api/payments/verify.ts as its own file
// pushed it to 13 and broke every deployment -- see PR #6):
//
// - POST /api/webhook/paystack            -- Paystack's own signed webhook
//   (HMAC-SHA512, verified below). Unauthenticated by design; Paystack is
//   the caller, not a browser, so no CORS applies here.
// - POST /api/webhook/paystack?action=verify -- the client-triggered
//   "I'm back from Paystack, verify me" path (formerly api/payments/verify.ts),
//   called after CheckoutScreen's Paystack popup reports success, or after
//   returning from a redirect-based channel like bank transfer/USSD via the
//   vents:// deep-link / ?paystack_ref= web fallback (see App.tsx).
//   Deliberately does NOT trust that client signal on its own: the only real
//   proof is Paystack's own GET /transaction/verify/:reference, called here
//   server-side with the secret key -- exactly the same authority the
//   webhook itself relies on via its HMAC-signed event. This is the second,
//   client-triggered path to that same authoritative confirmation, for when
//   the webhook is slow or the app closed before the popup's JS callback
//   could fire (common for bank_transfer/ussd/mobile_money channels, which
//   don't complete inside the iframe at all).
//
// Both paths funnel into finalizeAndConfirmPurchase (finalize_pending_
// purchase + confirm_ticket_payment, project_admin-only per
// supabase/migrations/0031_restrict_finalize_pending_purchase.sql) so they
// can never drift out of sync -- whichever runs first wins, the other is a
// no-op against the same locked rows.
//
// Set PAYSTACK_SECRET_KEY in Vercel environment variables.

import { sendPayoutDecisionEmail, sendTicketRefundEmail } from '../_lib/mailer.js';
import { callProjectAdminTableRpc, callProjectAdminRpc } from '../_lib/projectAdminDb.js';
import { finalizeAndConfirmPurchase, finalizeAndConfirmServiceBooking } from '../_lib/finalizePaystackPayment.js';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';
import { deliverPendingPushesForUser } from '../_lib/pushDelivery.js';
import crypto from 'crypto';

// After confirm_transfer_fee_payment confirms/no-ops a transfer-fee payment,
// trigger immediate push delivery for the notification it just inserted
// (from_user_id: "Your ticket transfer was accepted") instead of waiting
// for the daily cron sweep -- this is the fix for the hours-late
// ticket-transfer push. Never awaited by the caller in a way that could
// fail the webhook/verify response: deliverPendingPushesForUser already
// never throws, and this is fired after the response-determining work is
// done. Safe to call on every 'confirmed'/'already_paid' result, including
// a retried webhook for an already-delivered notification -- it only ever
// sends rows still marked unsent.
async function notifyTransferFeeOutcome(reference: string) {
  try {
    const fromUserId = await callProjectAdminRpc<string>('get_ticket_transfer_from_user', [reference]);
    if (fromUserId) await deliverPendingPushesForUser(fromUserId);
  } catch (err: any) {
    console.error('[Paystack webhook] notifyTransferFeeOutcome failed (non-fatal, cron sweep will retry):', err?.message || err);
  }
}

function fmtNaira(kobo) {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

export default async function handler(req, res) {
  if (req.query?.action === 'verify') return handleClientVerify(req, res);
  return handleWebhook(req, res);
}

// ── Client-triggered verify path (formerly api/payments/verify.ts) ───────
async function handleClientVerify(req, res) {
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
    console.error('[webhook/paystack?action=verify] PAYSTACK_SECRET_KEY not set');
    return res.status(500).json({ error: 'Payment verification not configured' });
  }

  // Ticket-transfer fee payments use the same Paystack-verify machinery as
  // a ticket purchase, distinguished only by their reference prefix
  // (initiate_transfer_fee_payment, 0043_ticket_transfer_fee.sql, always
  // generates 'txf_' + a random uuid) -- kept in this same handler rather
  // than a new serverless function (Vercel Hobby's 12-function cap is
  // already exactly hit, see this file's header comment).
  const isTransferFeeRef = reference.startsWith('txf_');
  const isServiceBookingRef = reference.startsWith('BKG-');
  // Resolved below (ticket-purchase branch only) from the incoming
  // reference -- which since 0060 may be a disposable per-attempt
  // paystack_ref, not pending_purchases' own stable payment_ref -- to the
  // stable payment_ref that finalize_pending_purchase/confirm_ticket_
  // payment/get_tickets_for_payment_ref all still key off, unchanged.
  let ticketPurchasePaymentRef = reference;

  try {
    // Ownership check: confirm the caller actually owns the payment this
    // reference belongs to (the pending purchase, or the transfer-fee
    // recipient) before spending a Paystack call or finalizing anything on
    // their say-so. A reference with no matching row (already finalized in
    // a prior call, or simply unknown) isn't itself an error here --
    // finalize_pending_purchase/confirm_ticket_payment's and
    // confirm_transfer_fee_payment's own idempotency and lookups below
    // handle that; this only blocks a caller asking about a reference that
    // demonstrably belongs to someone else.
    if (isTransferFeeRef) {
      const ownerId = await callProjectAdminRpc('get_transfer_fee_payment_owner', [reference]);
      if (ownerId && ownerId !== session.userId) {
        return res.status(403).json({ error: 'Not authorized for this payment reference' });
      }
    } else if (isServiceBookingRef) {
      const ownerId = await callProjectAdminRpc('get_service_booking_owner', [reference]);
      if (ownerId && ownerId !== session.userId) {
        return res.status(403).json({ error: 'Not authorized for this payment reference' });
      }
    } else {
      // get_pending_purchase_owner (0060) now resolves EITHER a disposable
      // per-attempt paystack_ref (every payment initiated via
      // initiate_ticket_payment_attempt, i.e. everything going forward) OR
      // a bare payment_ref (any pending_purchases row whose live Paystack
      // reference literally equalled its own payment_ref from BEFORE that
      // migration shipped) back to {payment_ref, owner_id, payer_id}.
      // reference itself is never assumed to already BE the stable
      // payment_ref from here on -- ticketPurchasePaymentRef (resolved
      // here) is what every downstream ticket-purchase call below uses
      // instead. Either the recipient (owner_id) OR the resolved
      // authenticated payer (payer_id, "someone else is paying") may
      // complete this payment -- never anyone else. A reference with no
      // matching row (already finalized, or unknown) is still not an error
      // here, per the original comment above -- ticketPurchasePaymentRef
      // falls back to the raw reference so finalizeAndConfirmPurchase's own
      // "not_found" handling still applies unchanged for a truly unknown one.
      const rows = await callProjectAdminTableRpc<{ payment_ref: string; owner_id: string; payer_id: string | null }>('get_pending_purchase_owner', [reference]);
      const row = rows[0];
      if (row && row.owner_id && session.userId !== row.owner_id && session.userId !== row.payer_id) {
        return res.status(403).json({ error: 'Not authorized for this payment reference' });
      }
      ticketPurchasePaymentRef = row?.payment_ref || reference;
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
      // Covers failed, abandoned, and cancelled payments alike -- Paystack's
      // own transaction record is the source of truth for all three; none
      // of them ever reach finalizeAndConfirmPurchase/confirm_transfer_fee_
      // payment, so no ticket is ever created and no transfer ownership
      // ever moves for a payment that didn't actually succeed.
      return res.status(200).json({ status: txStatus === 'abandoned' ? 'abandoned' : 'failed' });
    }

    if (typeof amountKobo !== 'number') {
      return res.status(502).json({ status: 'error', error: 'Paystack returned no amount for this transaction.' });
    }

    if (isTransferFeeRef) {
      const feeStatus = await callProjectAdminRpc<string>('confirm_transfer_fee_payment', [reference, amountKobo]);

      if (typeof feeStatus === 'string' && feeStatus.startsWith('amount_mismatch')) {
        const [, expected, got] = feeStatus.split(':');
        console.error('[webhook/paystack?action=verify] TRANSFER FEE AMOUNT MISMATCH for reference', reference, '-', expected, 'vs', got);
        return res.status(200).json({ status: 'error', error: 'Payment amount did not match the expected transfer fee.' });
      }
      if (feeStatus === 'not_found') {
        return res.status(200).json({ status: 'error', error: 'No matching transfer was found for this payment.' });
      }
      if (feeStatus === 'expired') {
        return res.status(200).json({ status: 'error', error: 'This transfer request has expired.' });
      }
      if (feeStatus === 'ticket_ineligible') {
        return res.status(200).json({ status: 'error', error: 'This ticket is no longer eligible for transfer.' });
      }
      if (typeof feeStatus === 'string' && feeStatus.startsWith('transfer_not_pending')) {
        return res.status(200).json({ status: 'error', error: 'This transfer is no longer pending.' });
      }

      // 'confirmed' or 'already_paid' -- either way the fee is paid and
      // ownership has moved (confirm_transfer_fee_payment does both
      // atomically), so this is a success from the client's perspective.
      await notifyTransferFeeOutcome(reference);
      return res.status(200).json({ status: 'success' });
    }

    if (isServiceBookingRef) {
      const bookingStatus = await finalizeAndConfirmServiceBooking(reference, amountKobo);

      if (bookingStatus.status === 'amount_mismatch') {
        console.error('[webhook/paystack?action=verify] SERVICE BOOKING AMOUNT MISMATCH for reference', reference, '-', bookingStatus.expectedKobo, 'vs', bookingStatus.gotKobo);
        return res.status(200).json({ status: 'error', error: 'Payment amount did not match the expected booking total.' });
      }
      if (bookingStatus.status === 'not_found') {
        return res.status(200).json({ status: 'error', error: 'No matching booking was found for this payment.' });
      }

      return res.status(200).json({ status: 'success' });
    }

    const result = await finalizeAndConfirmPurchase(ticketPurchasePaymentRef, amountKobo);

    if (result.status === 'amount_mismatch') {
      console.error('[webhook/paystack?action=verify] AMOUNT MISMATCH for reference', ticketPurchasePaymentRef, '-', result.expectedKobo, 'vs', result.gotKobo);
      return res.status(200).json({ status: 'error', error: 'Payment amount did not match the expected order amount.' });
    }
    if (result.status === 'not_found') {
      return res.status(200).json({ status: 'error', error: 'No matching order was found for this payment.' });
    }
    if (result.status === 'confirmed_lookup_failed') {
      // Payment IS confirmed at this point (payment_status='paid', wallet
      // already credited) -- only the ticket-id readback failed. Still
      // reported as status: 'success' (it genuinely is one) so the client
      // never shows a failure/refund-support message for a payment that
      // went through; ticketIds is empty and ticketLookupPending tells the
      // client to fall back to a Wallet refresh instead of expecting an
      // instant ticket_id/token.
      return res.status(200).json({ status: 'success', ticketIds: [], ticketLookupPending: true });
    }

    return res.status(200).json({ status: 'success', ticketIds: result.ticketIds });
  } catch (err: any) {
    console.error('[webhook/paystack?action=verify] error:', err?.message || err);
    return res.status(500).json({ status: 'error', error: 'Payment verification failed. Please try again or contact support.' });
  }
}

// ── Paystack's own signed webhook ─────────────────────────────────────────
async function handleWebhook(req, res) {
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

    if (reference.startsWith('txf_')) {
      // Same recovery-path reasoning as the ticket-purchase branch below,
      // for a transfer-fee payment: this is the authoritative confirmation
      // (Paystack's own signed webhook event) if the client's own ?action=
      // verify call never fired. confirm_transfer_fee_payment is idempotent
      // (fee_paid_at IS NOT NULL short-circuits to 'already_paid'), so
      // whichever of the two paths runs first wins and the other no-ops.
      try {
        const feeStatus = await callProjectAdminRpc<string>('confirm_transfer_fee_payment', [reference, amountKobo]);
        if (typeof feeStatus === 'string' && feeStatus.startsWith('amount_mismatch')) {
          console.error('[Paystack webhook] TRANSFER FEE AMOUNT MISMATCH for reference', reference, '-', feeStatus);
        } else {
          console.log('[Paystack webhook] transfer fee', feeStatus, 'for reference', reference);
          if (feeStatus === 'confirmed' || feeStatus === 'already_paid') {
            await notifyTransferFeeOutcome(reference);
          }
        }
      } catch (err: any) {
        console.error('[Paystack webhook] Error calling confirm_transfer_fee_payment:', err?.message || err);
      }
      return res.status(200).json({ received: true });
    }

    if (reference.startsWith('BKG-')) {
      // Services marketplace booking payment -- same authoritative-webhook
      // reasoning as the ticket branch below, sharing finalizeAndConfirm
      // ServiceBooking with the ?action=verify path so both can never
      // drift out of sync.
      try {
        const bookingStatus = await finalizeAndConfirmServiceBooking(reference, amountKobo);
        if (bookingStatus.status === 'amount_mismatch') {
          console.error('[Paystack webhook] SERVICE BOOKING AMOUNT MISMATCH for reference', reference, '-', bookingStatus.expectedKobo, 'vs', bookingStatus.gotKobo);
        } else {
          console.log('[Paystack webhook] service booking', bookingStatus.status, 'for reference', reference);
        }
      } catch (err: any) {
        console.error('[Paystack webhook] Error calling confirm_service_booking_payment:', err?.message || err);
      }
      return res.status(200).json({ received: true });
    }

    try {
      // Recovery path: if the client was killed/crashed/lost network between
      // Paystack charging the card and its own verify call
      // (this file's ?action=verify path), this is what still gets the
      // buyer a ticket -- this is the authoritative confirmation path
      // (Paystack's own signed webhook event, HMAC-verified above), not a
      // fallback to it. Shared with the ?action=verify path via
      // finalizeAndConfirmPurchase so the two can never drift out of sync;
      // whichever runs first wins, the other no-ops against the same
      // locked rows.
      //
      // reference here is whatever Paystack itself echoes back on the
      // charge -- since 0060 that's the disposable per-attempt
      // paystack_ref, not pending_purchases' own stable payment_ref.
      // Resolve it the same way the ?action=verify path does before
      // calling finalizeAndConfirmPurchase, which still expects the stable
      // payment_ref. get_pending_purchase_owner (0060) also matches a bare
      // payment_ref for any pre-0060 row, so this stays correct for a
      // payment that was already in flight when this migration shipped.
      const ownerRows = await callProjectAdminTableRpc<{ payment_ref: string }>('get_pending_purchase_owner', [reference]);
      const resolvedPaymentRef = ownerRows[0]?.payment_ref || reference;

      const result = await finalizeAndConfirmPurchase(resolvedPaymentRef, amountKobo);

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
        // credited) -- only the ticket-id readback failed, which this path
        // doesn't even use. Logged for visibility, not an error condition.
        console.warn('[Paystack webhook] Ticket confirmed but id lookup failed for reference', reference);
      }
    } catch (err: any) {
      console.error('[Paystack webhook] Error calling confirm_ticket_payment:', err?.message || err);
    }
  }

  // ── Organizer payout transfer status ──────────────────────────────────
  // This is the authoritative completion signal for a payout -- the
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
      // service_role EXECUTE grant) -- called via the direct project_admin
      // Postgres connection, same as the ticket-confirmation block above
      // (see api/_lib/projectAdminDb.ts).
      const rpcName = event.event === 'transfer.success' ? 'complete_organizer_payout' : 'fail_organizer_payout';
      const rows = event.event === 'transfer.success'
        ? await callProjectAdminTableRpc<any>('complete_organizer_payout', [lookupKey])
        : await callProjectAdminTableRpc<any>('fail_organizer_payout', [lookupKey, event.data?.reason || event.event]);
      const row = rows[0];
      console.log(`[Paystack webhook] ${event.event} -> ${rpcName} result:`, row?.status, 'for', lookupKey);

      // Fire the payout email only on a genuine, first-time state change --
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
      // with no internal auth check -- that id alone would be enough to
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
