import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { applyCors } from '../_lib/cors.js';

// Simple in-memory cache — Paystack's bank list changes rarely and this
// avoids hitting their API on every "+ Update Bank" screen open within the
// same lambda instance's lifetime.
let cache: { data: any; fetchedAt: number } | null = null;
const CACHE_MS = 60 * 60 * 1000; // 1 hour

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await verifyInsforgeSession(req.headers.authorization);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) {
    return res.status(200).json({ banks: cache.data });
  }

  try {
    const pRes = await fetch('https://api.paystack.co/bank?currency=NGN&country=nigeria', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const pJson = await pRes.json();
    if (!pRes.ok || !pJson.status) {
      return res.status(502).json({ error: pJson.message || 'Failed to fetch bank list' });
    }
    const banks = (pJson.data || []).map((b: any) => ({ name: b.name, code: b.code }));
    cache = { data: banks, fetchedAt: Date.now() };
    return res.status(200).json({ banks });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch bank list' });
  }
}
