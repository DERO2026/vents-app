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
  //
  // Wallet rate-limit investigation: this used to catch EVERYTHING here
  // (a genuine rate_limited exception from check_rate_limit itself, a
  // missing PROJECT_ADMIN_DATABASE_URL, a dropped Postgres connection, any
  // other unrelated error) and report every one of them to the user as
  // "Too many requests" -- so a real infra/config problem looked
  // identical to actually hitting the limit, and users reported being
  // "repeatedly" rate-limited when the true cause could have been
  // something failing on every single call, not request volume at all.
  // check_rate_limit() raises specifically with ERRCODE 'P0429' for a
  // genuine limit hit (supabase/migrations -- see check_rate_limit's own
  // definition); the pg driver surfaces that as err.code === 'P0429'.
  // Still fails CLOSED either way (neither branch lets the Paystack call
  // below proceed), but now tells the truth about which failure occurred.
  try {
    const { callProjectAdminRpc } = await import('../_lib/projectAdminDb.js');
    await callProjectAdminRpc('check_rate_limit', [`paystack_resolve_account:${session.userId}`, 30, 3600]);
  } catch (err: any) {
    // Match both the real pg driver's SQLSTATE surfacing (err.code,
    // 'P0429' -- check_rate_limit's own RAISE EXCEPTION ... USING ERRCODE)
    // and a plain message match, the same convention aiEntitlement.ts
    // already uses for its own RAISE EXCEPTION 'code_name' pattern --
    // genuinely matters here since callProjectAdminRpc's real pg error
    // objects may not always preserve .code through every driver/pooling
    // path, and this must never under-detect a real rate-limit hit.
    if (err?.code === 'P0429' || /rate_limited/.test(String(err?.message))) {
      return res.status(429).json({ error: 'Too many requests. Please try again in a bit.' });
    }
    // eslint-disable-next-line no-console
    console.error('[resolve-account] rate-limit check failed (not a genuine rate limit -- failing closed):', err?.message || err);
    return res.status(503).json({ error: 'Account verification is temporarily unavailable. Please try again shortly.' });
  }

  try {
    const pRes = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const pJson = await pRes.json();
    if (!pRes.ok || !pJson.status) {
      // Distinguish PAYSTACK's own throttling (their HTTP 429, a real
      // provider rate limit, nothing to do with VENTS's own check_rate_limit
      // above) from an actual invalid-account response -- folding both into
      // the same generic "check the number and bank" message told a
      // throttled user their bank details were wrong, which they weren't.
      if (pRes.status === 429) {
        return res.status(429).json({ error: 'Our banking provider is temporarily busy. Please try again in a moment.' });
      }
      return res.status(422).json({ error: pJson.message || 'Could not verify account. Check the number and bank.' });
    }
    return res.status(200).json({ account_name: pJson.data.account_name, account_number: pJson.data.account_number });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Account resolution failed' });
  }
}
