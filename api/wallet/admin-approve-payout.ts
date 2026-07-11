import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors } from '../lib/cors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { request_id } = req.body || {};
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
  if (!secret || !baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  const insforgeHeaders = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    apikey: anonKey,
  };

  try {
    // is_admin() is enforced inside this RPC — a non-admin caller gets a
    // clean rejection here, before we ever touch Paystack.
    const fetchRes = await fetch(`${baseUrl}/api/database/rpc/admin_get_payout_for_processing`, {
      method: 'POST',
      headers: insforgeHeaders,
      body: JSON.stringify({ p_request_id: request_id }),
    });
    if (!fetchRes.ok) {
      const errJson = await fetchRes.json().catch(() => null);
      return res.status(fetchRes.status).json({ error: errJson?.message || 'Admin access required' });
    }
    const rows = await fetchRes.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(404).json({ error: 'Payout request not found' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Request is already ${row.status}, not pending` });
    }
    if (!row.recipient_code) {
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
        amount: row.amount_kobo,
        recipient: row.recipient_code,
        reason: 'Vents organizer payout',
        reference,
      }),
    });
    const transferJson = await transferRes.json();

    if (!transferRes.ok || !transferJson.status) {
      // Nothing was marked processing — the request stays 'pending' and
      // the funds stay held, so the admin can safely retry.
      return res.status(502).json({ error: transferJson.message || 'Paystack transfer initiation failed' });
    }

    // Paystack accepted the transfer. Depending on the account's OTP
    // settings this may still require finalization on Paystack's side —
    // transfer.success / transfer.failed webhooks are the authoritative
    // completion signal (see api/webhook/paystack.ts), not this response.
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
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Approve payout failed' });
  }
}
