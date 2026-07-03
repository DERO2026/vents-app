// @ts-nocheck
// Vercel serverless function: POST /api/webhook/paystack
// Verifies Paystack webhook HMAC-SHA512 signature before processing.
// Set PAYSTACK_SECRET_KEY in Vercel environment variables.

const crypto = require('crypto');

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
      const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
      if (!baseUrl || !anonKey) {
        console.error('[Paystack webhook] VITE_INSFORGE_URL or VITE_INSFORGE_ANON_KEY not set');
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
          Authorization: `Bearer ${anonKey}`,
          apikey: anonKey,
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

  // Always 200 so Paystack does not endlessly retry.
  return res.status(200).json({ received: true });
}
