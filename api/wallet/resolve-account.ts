import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../lib/verifyAuth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require the caller to be a signed-in Vents user — this endpoint spends
  // a Paystack API call per request. A non-empty header alone proves
  // nothing; this actually round-trips to InsForge and verifies the token
  // is a live session before we spend anything.
  const session = await verifyInsforgeSession(req.headers.authorization);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { account_number, bank_code } = req.body || {};
  if (!account_number || typeof account_number !== 'string' || !/^\d{10}$/.test(account_number)) {
    return res.status(400).json({ error: 'account_number must be a 10-digit string' });
  }
  if (!bank_code || typeof bank_code !== 'string') {
    return res.status(400).json({ error: 'bank_code is required' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  try {
    const pRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const pJson = await pRes.json();
    if (!pRes.ok || !pJson.status) {
      return res.status(422).json({ error: pJson.message || 'Could not verify account. Check the number and bank.' });
    }
    return res.status(200).json({ account_name: pJson.data.account_name, account_number: pJson.data.account_number });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Account resolution failed' });
  }
}
