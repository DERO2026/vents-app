import type { VercelRequest, VercelResponse } from '@vercel/node';

// ─── Event-reminder sweep (Vercel Cron) ───────────────────────────────────
// Populates the 24h-out / 1h-out reminder notifications (push_data included,
// so send-pending-pushes.ts's next run actually delivers them) by calling
// run_event_reminder_sweep() — all the "which tickets, which window, have I
// already reminded this one" logic lives in that RPC
// (migrations/20260806020300_event-reminder-sweep.sql) since it's a set-
// based query best done in Postgres, not fetched row-by-row into Node.
//
// Same CRON_SECRET + INSFORGE_API_KEY auth shape as send-pending-pushes.ts —
// see that file's header comment for why they're not sharing one handler.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  const baseUrl = process.env.VITE_INSFORGE_URL;
  const adminKey = process.env.INSFORGE_API_KEY;
  if (!baseUrl || !adminKey) return res.status(500).json({ error: 'Backend not configured' });

  const sweepRes = await fetch(`${baseUrl}/api/database/rpc/run_event_reminder_sweep`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminKey}`,
      apikey: adminKey,
    },
    body: JSON.stringify({}),
  });

  if (!sweepRes.ok) {
    return res.status(502).json({ error: 'Reminder sweep failed', status: sweepRes.status });
  }

  const result = await sweepRes.json();
  return res.status(200).json(Array.isArray(result) ? result[0] : result);
}
