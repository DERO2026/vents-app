import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // A non-empty header alone proves nothing — this call is about to spend
  // real Paystack API calls (account resolve + transfer-recipient creation)
  // and persist a bank account, so verify the token is a live session first.
  const authHeader = req.headers.authorization;
  const session = await verifyInsforgeSession(authHeader);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { account_number, bank_code, bank_name } = req.body || {};
  if (!account_number || !/^\d{10}$/.test(account_number)) {
    return res.status(400).json({ error: 'account_number must be a 10-digit string' });
  }
  if (!bank_code || !bank_name) {
    return res.status(400).json({ error: 'bank_code and bank_name are required' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
  if (!secret || !baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  try {
    // Re-resolve server-side rather than trusting a client-supplied
    // account_name — the whole point of this step is verifying who the
    // money would actually go to.
    const resolveRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const resolveJson = await resolveRes.json();
    if (!resolveRes.ok || !resolveJson.status) {
      return res.status(422).json({ error: resolveJson.message || 'Could not verify account.' });
    }
    const verifiedAccountName = resolveJson.data.account_name;

    // Create (or reuse) a Paystack transfer recipient for this account.
    const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'nuban',
        name: verifiedAccountName,
        account_number,
        bank_code,
        currency: 'NGN',
      }),
    });
    const recipientJson = await recipientRes.json();
    if (!recipientRes.ok || !recipientJson.status) {
      return res.status(502).json({ error: recipientJson.message || 'Could not register bank account with Paystack.' });
    }
    const recipientCode = recipientJson.data.recipient_code;

    // Persist via the organizer's own auth context (forwarded token) so
    // auth.uid() inside the RPC resolves to the real organizer, not us.
    const rpcRes = await fetch(`${baseUrl}/api/database/rpc/upsert_organizer_bank_account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        apikey: anonKey,
      },
      body: JSON.stringify({
        p_bank_name: bank_name,
        p_bank_code: bank_code,
        p_account_number: account_number,
        p_account_name: verifiedAccountName,
        p_recipient_code: recipientCode,
      }),
    });
    if (!rpcRes.ok) {
      const errJson = await rpcRes.json().catch(() => null);
      return res.status(rpcRes.status).json({ error: errJson?.message || 'Could not save bank account.' });
    }

    return res.status(200).json({ account_name: verifiedAccountName, recipient_code: recipientCode });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to save bank account' });
  }
}
