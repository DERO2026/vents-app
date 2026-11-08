import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';
import { callProjectAdminRpc } from '../_lib/projectAdminDb.js';
// Cross-boundary import by design: this is the SAME file
// PromoteEventScreen.tsx imports its own plan prices from. Before this,
// each side hand-copied the same numbers, and they had already drifted
// out of sync (see eventPromotionPricing.ts's own top comment for the
// exact bug this caused -- every real Trending/Featured payment was being
// rejected here as an amount mismatch, against the wrong expected
// number). Vercel's Node function bundler resolves relative imports by
// real filesystem path at build time, independent of tsconfig's
// "include": ["src"] (that scope only governs `tsc --noEmit`/Vite's own
// type-checking, not what a serverless function can import), so this
// works the same way every other relative import in this file does.
import {
  EVENT_PROMOTION_PRICES_NAIRA,
  EVENT_PROMOTION_PLAN_DB_TYPE,
  isEventPromotionPlan,
  isEventPromotionDuration,
  type EventPromotionPlan,
  type EventPromotionDuration,
} from '../../src/lib/eventPromotionPricing.js';
import { refuseInPreview } from '../_lib/previewGuard.js';

// Paystack financial-exposure audit finding: this endpoint's Paystack
// verification call had no rate limit at all -- an authenticated user
// could repeatedly call it with arbitrary reference values, each one a
// real Paystack API request. activate_event_promotion's own idempotency
// (ON CONFLICT DO NOTHING on payment_ref) already prevents any duplicate
// activation, so this was never a duplicate-money risk -- just unnecessary
// provider exposure. Matches the existing bank-resolution ceiling
// (resolve-account.ts: 30/hour/user) since both are a per-user-gated,
// non-money-moving Paystack verification call of the same shape.
const PROMOTION_VERIFY_RATE_MAX = 30;
const PROMOTION_VERIFY_RATE_WINDOW_SECONDS = 3600;

// Local Plan/Duration aliases removed (Phase 6) -- this file now uses
// EventPromotionPlan/EventPromotionDuration directly from
// eventPromotionPricing.ts instead of redeclaring its own copy, so a
// future plan addition/removal there can't silently drift out of sync
// with this file's own type again (the exact class of bug that caused
// the swapped Trending/Featured prices this pricing centralization
// fixed). PRICES/PLAN_TYPE read directly off the same shared constants:
// Spotlight/'boosted' is no longer a member of EventPromotionPlan at
// all, so `isEventPromotionPlan('spotlight')` below returns false and
// any new Spotlight purchase/activation attempt is rejected with 400
// before Paystack is ever called.
type Plan = EventPromotionPlan;
type Duration = EventPromotionDuration;

const PRICES: Record<Plan, Record<Duration, number>> = EVENT_PROMOTION_PRICES_NAIRA;

const PLAN_TYPE: Record<Plan, string> = EVENT_PROMOTION_PLAN_DB_TYPE;

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
  if (refuseInPreview(res, 'promotion activation')) return;

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
  if (!isEventPromotionPlan(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  if (!isEventPromotionDuration(duration_days)) {
    return res.status(400).json({ error: 'Invalid duration_days' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Not configured' });
  }

  // Checked after every request/business validation above, strictly before
  // the Paystack verify call below. Fails CLOSED: a genuine limit hit OR an
  // RPC/infra failure both block the request here -- Paystack is never
  // called after a rejection.
  try {
    await callProjectAdminRpc('check_rate_limit', [`paystack_promotion_verify:${session.userId}`, PROMOTION_VERIFY_RATE_MAX, PROMOTION_VERIFY_RATE_WINDOW_SECONDS]);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Please try again in a bit.' });
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
