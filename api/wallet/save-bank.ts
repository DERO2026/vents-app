import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession, confirmPassword, enforceWalletRateLimit } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';

// Organizer bank-account mutations — add/edit (default action), set_default,
// and remove. EVERY action is guarded by a mandatory password (or
// biometric-unlocked password) re-confirmation and strict rate limiting:
// changing where money is paid out is the most sensitive mutation in the app,
// so a valid session alone is deliberately NOT sufficient. All three actions
// live in this single function to stay within the serverless function budget.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const session = await verifyInsforgeSession(authHeader);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const body = req.body || {};
  const action: 'add' | 'set_default' | 'remove' = body.action || 'add';
  if (!['add', 'set_default', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!baseUrl || !anonKey) return res.status(500).json({ error: 'Payout system not configured' });

  // ── Rate limit (strict): ≤ 8 bank mutations / 10 min / user ─────────────
  const okRate = await enforceWalletRateLimit(authHeader!, session.userId);
  if (!okRate) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });

  // ── Security gate: re-confirm the organizer's password server-side. The
  // returned FRESH token (recent `iat`) is what the confirmed-mutation RPCs
  // require, so the gate can't be bypassed by replaying an older session. ──
  const freshToken = await confirmPassword(session.email, body.password);
  if (!freshToken) return res.status(403).json({ error: 'Password confirmation failed. Please re-enter your password.' });

  const rpcHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}`, apikey: anonKey };
  const callRpc = async (fn: string, params: any) => {
    const r = await fetch(`${baseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers: rpcHeaders, body: JSON.stringify(params) });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      const msg = j?.message || '';
      if (/PASSWORD_CONFIRMATION_REQUIRED/.test(msg)) {
        const e: any = new Error('Password confirmation failed. Please re-enter your password.'); e.status = 403; throw e;
      }
      const e: any = new Error(msg || 'Could not update bank account.'); e.status = r.status; throw e;
    }
    return r.json().catch(() => ({}));
  };

  try {
    // ── set_default / remove ──────────────────────────────────────────────
    if (action === 'set_default' || action === 'remove') {
      if (!body.account_id || typeof body.account_id !== 'string') {
        return res.status(400).json({ error: 'account_id is required' });
      }
      const fn = action === 'set_default' ? 'set_default_bank_account_confirmed' : 'remove_bank_account_confirmed';
      await callRpc(fn, { p_account_id: body.account_id });
      return res.status(200).json({ ok: true });
    }

    // ── add / edit ────────────────────────────────────────────────────────
    const { account_number, bank_code, bank_name } = body;
    if (!account_number || !/^\d{10}$/.test(account_number)) {
      return res.status(400).json({ error: 'account_number must be a 10-digit string' });
    }
    if (!bank_code || !bank_name) {
      return res.status(400).json({ error: 'bank_code and bank_name are required' });
    }
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: 'Payout system not configured' });

    // Re-resolve server-side rather than trusting a client-supplied name.
    const resolveRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const resolveJson = await resolveRes.json();
    if (!resolveRes.ok || !resolveJson.status) {
      return res.status(422).json({ error: resolveJson.message || 'Could not verify account.' });
    }
    const verifiedAccountName = resolveJson.data.account_name;

    // Create (or reuse) a Paystack transfer recipient.
    const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'nuban', name: verifiedAccountName, account_number, bank_code, currency: 'NGN' }),
    });
    const recipientJson = await recipientRes.json();
    if (!recipientRes.ok || !recipientJson.status) {
      return res.status(502).json({ error: recipientJson.message || 'Could not register bank account with Paystack.' });
    }
    const recipientCode = recipientJson.data.recipient_code;

    await callRpc('add_bank_account_confirmed', {
      p_bank_name: bank_name,
      p_bank_code: bank_code,
      p_account_number: account_number,
      p_account_name: verifiedAccountName,
      p_recipient_code: recipientCode,
    });

    return res.status(200).json({ account_name: verifiedAccountName, recipient_code: recipientCode });
  } catch (err: any) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to update bank account' });
  }
}
