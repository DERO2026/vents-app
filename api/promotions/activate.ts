import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';
import { callProjectAdminRpc } from '../_lib/projectAdminDb.js';

type Plan = 'spotlight' | 'featured' | 'trending';
type Duration = 3 | 7 | 14 | 30;

// Mirrors PromoteEventScreen.tsx's PLANS pricing table — the source of
// truth for what a given plan/duration is actually supposed to cost, so
// the amount Paystack reports as paid can be checked against it server-side.
const PRICES: Record<Plan, Record<Duration, number>> = {
  spotlight: { 3: 5000, 7: 10000, 14: 18000, 30: 30000 },
  featured: { 3: 15000, 7: 28000, 14: 48000, 30: 80000 },
  trending: { 3: 35000, 7: 65000, 14: 110000, 30: 180000 },
};

const PLAN_TYPE: Record<Plan, string> = { spotlight: 'boosted', featured: 'featured', trending: 'trending' };

// Activates an event promotion only after independently verifying the
// Paystack transaction server-side — PromoteEventScreen.tsx previously
// wrote is_featured/event_promotions directly from the browser inside the
// Paystack popup's onSuccess callback, trusting the client's report that
// payment succeeded (and, since the events table had no column
// protection, a direct table write could grant a free "Featured Campaign"
// with zero payment at all). This endpoint is the only path left that can
// set those columns; the DB-side trigger + activate_event_promotion() RPC
// enforce that server-side.
//
// activate_event_promotion is project_admin-only (see migration
// fix_activate_event_promotion_payment_bypass) -- it used to be callable
// with the client's own forwarded session token, which meant any
// organizer could call it directly from the browser with a fabricated
// payment_ref and skip this route's Paystack verification entirely. It
// now takes an explicit p_organizer_id (this route's own
// session-verified user id) instead of reading auth.uid(), and is only
// reachable over the project_admin connection below.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const session = await verifyInsforgeSession(authHeader);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { event_id, reference, plan, duration_days } = req.body || {};
  if (!event_id || typeof event_id !== 'string') {
    return res.status(400).json({ error: 'event_id is required' });
  }
  if (!reference || typeof reference !== 'string') {
    return res.status(400).json({ error: 'reference is required' });
  }
  if (!plan || !(plan in PRICES)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  if (![3, 7, 14, 30].includes(duration_days)) {
    return res.status(400).json({ error: 'Invalid duration_days' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Not configured' });
  }

  try {
    const expectedKobo = PRICES[plan as Plan][duration_days as Duration] * 100;

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const verifyJson = await verifyRes.json();
    if (!verifyRes.ok || !verifyJson.status) {
      return res.status(502).json({ error: verifyJson.message || 'Could not verify payment' });
    }
    const tx = verifyJson.data;
    if (tx?.status !== 'success') {
      return res.status(402).json({ error: 'Payment was not successful' });
    }
    if (Number(tx?.amount) !== expectedKobo) {
      return res.status(402).json({ error: 'Payment amount does not match the selected plan' });
    }

    // activate_event_promotion() re-verifies ownership against this
    // session's own user id and is idempotent on payment_ref (ON CONFLICT
    // DO NOTHING), so a retry with the same reference is a safe no-op.
    await callProjectAdminRpc('activate_event_promotion', [
      event_id,
      PLAN_TYPE[plan as Plan],
      duration_days,
      reference,
      session.userId,
    ]);

    return res.status(200).json({ status: 'active' });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Promotion activation failed' });
  }
}
