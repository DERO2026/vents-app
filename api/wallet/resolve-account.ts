import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

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

  // Billing-audit finding: this endpoint spends a Paystack API call per
  // request (see the comment above) but had no server-side rate limit at
  // all -- the only friction was WalletScreen.tsx's own debounce, which a
  // caller hitting this endpoint directly simply doesn't go through.
  // Reuses the same check_rate_limit primitive the ticket-resend fix
  // (commit 39b5405) and the Paystack verify endpoints already use, via
  // the trusted project_admin connection -- no new RPC, no migration.
  // Deliberately calls check_rate_limit directly rather than
  // enforceRateLimit (verifyAuth.ts): enforceRateLimit fails OPEN on a
  // non-rate-limit error, which is right for a soft throttle but wrong
  // here -- a Paystack-call gate must fail CLOSED (any error, not just a
  // genuine limit hit, blocks the call) so an infra hiccup never becomes
  // "spend anyway". Checked before the Paystack fetch below.
  try {
    const { callProjectAdminRpc } = await import('../_lib/projectAdminDb.js');
    await callProjectAdminRpc('check_rate_limit', [`paystack_resolve_account:${session.userId}`, 30, 3600]);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Please try again in a bit.' });
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
