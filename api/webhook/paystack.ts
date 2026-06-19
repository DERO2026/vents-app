// Vercel serverless function: POST /api/webhook/paystack
// Verifies Paystack webhook HMAC-SHA512 signature before processing.
// Set PAYSTACK_SECRET_KEY in Vercel environment variables.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // TODO: handle charge.success → mark ticket paid via InsForge RPC
  // Example:
  // if (event?.event === 'charge.success') {
  //   const ref = event.data?.reference;
  //   await insforge.database.rpc('confirm_payment', { p_payment_ref: ref });
  // }

  return res.status(200).json({ received: true });
}
