// @ts-nocheck
// Vercel serverless function: POST /api/webhook/paystack
// Verifies Paystack webhook HMAC-SHA512 signature before processing.
// Set PAYSTACK_SECRET_KEY in Vercel environment variables.

import { sendPayoutDecisionEmail, sendTicketRefundEmail } from '../_lib/mailer.js';
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

  if (signature !== expected) {
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
      const baseUrl = process.env.VITE_INSFORGE_URL;
      // confirm_ticket_payment has no internal auth check of its own (it
      // trusts this webhook's HMAC verification above, not RLS) — calling
      // it with the anon key meant any signed-in user could hit the same
      // RPC directly over the InsForge REST surface with a self-chosen
      // reference/amount and mark their own tickets paid. Requires the
      // admin-only API_KEY secret now that EXECUTE has been revoked from
      // anon/authenticated in
      // migrations/20260731194723_lockdown-ticket-payment-confirm-refund-rpcs.sql.
      const adminKey = process.env.INSFORGE_API_KEY;
      if (!baseUrl || !adminKey) {
        console.error('[Paystack webhook] VITE_INSFORGE_URL or INSFORGE_API_KEY not set');
        return res.status(200).json({ received: true });
      }

      // confirm_ticket_payment is SECURITY DEFINER and does the whole thing
      // atomically: look up the ticket by payment_ref, verify the webhook's
      // amount (kobo) exactly matches the ticket's stored amount, no-op if
      // already paid, otherwise mark paid + credit organizer wallet + notify.
      const rpcRes = await fetch(`${baseUrl}/api/database/rpc/confirm_ticket_payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminKey}`,
          apikey: adminKey,
        },
        body: JSON.stringify({ p_reference: reference, p_amount_kobo: amountKobo }),
      });

      const result = await rpcRes.json().catch(() => null);
      const status = typeof result === 'string' ? result : result?.data ?? result;

      if (!rpcRes.ok) {
        console.error('[Paystack webhook] confirm_ticket_payment call failed', rpcRes.status, result);
      } else if (typeof status === 'string' && status.startsWith('amount_mismatch')) {
        console.error('[Paystack webhook] AMOUNT MISMATCH for reference', reference, '-', status);
      } else if (status === 'not_found') {
        console.warn('[Paystack webhook] No ticket found for reference', reference);
      } else if (status === 'already_paid') {
        console.log('[Paystack webhook] Ticket already paid, no-op for reference', reference);
      } else if (status === 'confirmed') {
        console.log('[Paystack webhook] Ticket confirmed for reference', reference);
      } else {
        console.warn('[Paystack webhook] Unexpected confirm_ticket_payment result', result);
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
      const baseUrl = process.env.VITE_INSFORGE_URL;
      // complete_organizer_payout/fail_organizer_payout have no internal
      // auth check of their own (they trust this webhook's HMAC verification
      // above, not RLS) — calling them with the anon key meant ANY signed-in
      // user could hit the same RPC directly over the InsForge REST surface
      // and finalize/reverse their own payout early. Requires the admin-only
      // API_KEY secret (never the client-exposed VITE_ anon key) now that
      // EXECUTE has been revoked from anon/authenticated in
      // migrations/20260731070000_lockdown-payout-completion-rpcs.sql.
      const adminKey = process.env.INSFORGE_API_KEY;
      if (!baseUrl || !adminKey) {
        console.error('[Paystack webhook] VITE_INSFORGE_URL or INSFORGE_API_KEY not set');
        return res.status(200).json({ received: true });
      }

      const rpcName = event.event === 'transfer.success' ? 'complete_organizer_payout' : 'fail_organizer_payout';
      const body = event.event === 'transfer.success'
        ? { p_request_id: lookupKey }
        : { p_request_id: lookupKey, p_reason: event.data?.reason || event.event };

      const rpcRes = await fetch(`${baseUrl}/api/database/rpc/${rpcName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminKey}`,
          apikey: adminKey,
        },
        body: JSON.stringify(body),
      });

      const result = await rpcRes.json().catch(() => null);
      const rows = Array.isArray(result) ? result : result?.data ?? result;
      const row = Array.isArray(rows) ? rows[0] : rows;
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
      const baseUrl = process.env.VITE_INSFORGE_URL;
      // finalize_ticket_refund / fail_ticket_refund are keyed only on
      // Paystack's own numeric refund id (short, sequential, enumerable)
      // with no internal auth check — calling them with the anon key meant
      // that id alone was enough to revert someone else's in-flight refund
      // over the InsForge REST surface. Requires the admin-only API_KEY
      // secret now that EXECUTE has been revoked from anon/authenticated in
      // migrations/20260731194723_lockdown-ticket-payment-confirm-refund-rpcs.sql.
      const adminKey = process.env.INSFORGE_API_KEY;
      if (!baseUrl || !adminKey) {
        console.error('[Paystack webhook] VITE_INSFORGE_URL or INSFORGE_API_KEY not set');
        return res.status(200).json({ received: true });
      }

      const insforgeHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminKey}`,
        apikey: adminKey,
      };

      if (event.event === 'refund.processed') {
        const rpcRes = await fetch(`${baseUrl}/api/database/rpc/finalize_ticket_refund`, {
          method: 'POST',
          headers: insforgeHeaders,
          body: JSON.stringify({ p_refund_id: refundId }),
        });
        const rows = await rpcRes.json().catch(() => null);
        const row = Array.isArray(rows) ? rows[0] : rows?.data ?? rows;
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
        const rpcRes = await fetch(`${baseUrl}/api/database/rpc/fail_ticket_refund`, {
          method: 'POST',
          headers: insforgeHeaders,
          body: JSON.stringify({ p_refund_id: refundId, p_reason: event.data?.message || event.event }),
        });
        const rows = await rpcRes.json().catch(() => null);
        const row = Array.isArray(rows) ? rows[0] : rows?.data ?? rows;
        console.log('[Paystack webhook] refund.failed -> fail_ticket_refund result:', row?.status, 'for', refundId);
      }
    } catch (err: any) {
      console.error(`[Paystack webhook] Error handling ${event.event}:`, err?.message || err);
    }
  }

  // Always 200 so Paystack does not endlessly retry.
  return res.status(200).json({ received: true });
}
