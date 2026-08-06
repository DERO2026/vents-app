import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

// ─── Push-delivery worker (Vercel Cron) ───────────────────────────────────
// The actual gap this closes: every INSERT INTO public.notifications across
// the app (ticket confirmed, new sale, new message, event reminder/update)
// only ever populated the in-app bell list — nothing called Firebase.
// api/push/send.ts sends real pushes but only one super-admin-triggered user
// at a time. This sweeps ALL users' unsent notification rows on a schedule
// and actually delivers them, reusing the same FCM v1 JWT-signing approach
// as api/push/send.ts (kept duplicated rather than shared — this endpoint
// authenticates with the INSFORGE_API_KEY service credential and a
// CRON_SECRET, not a user session, different enough auth shape that sharing
// a handler would be more confusing than two short files).
//
// No user session exists for a scheduled job, so this reads/writes the
// database via INSFORGE_API_KEY (the same admin-only credential
// api/webhook/paystack.ts and api/wallet/reconcile-payouts.ts already use)
// against RPCs locked to `project_admin` — see
// migrations/20260806020300_event-reminder-sweep.sql.

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const data = await res.json();
  return data.access_token as string;
}

interface PendingRow {
  notification_id: string;
  user_id: string;
  title: string;
  body: string;
  push_data: Record<string, string> | null;
  token: string | null;
  platform: string | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel injects this header automatically for cron-triggered invocations
  // when CRON_SECRET is set — see https://vercel.com/docs/cron-jobs/manage-cron-jobs.
  // Without this check anyone who found the URL could trigger unlimited FCM
  // sends against every user's device.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  const baseUrl = process.env.VITE_INSFORGE_URL;
  const adminKey = process.env.INSFORGE_API_KEY;
  const saJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!baseUrl || !adminKey) return res.status(500).json({ error: 'Backend not configured' });
  if (!saJson) return res.status(503).json({ error: 'Push not configured (FCM_SERVICE_ACCOUNT_JSON missing)' });

  let sa: { project_id: string; client_email: string; private_key: string };
  try {
    sa = JSON.parse(saJson);
  } catch {
    return res.status(500).json({ error: 'FCM_SERVICE_ACCOUNT_JSON is not valid JSON' });
  }

  const systemHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminKey}`,
    apikey: adminKey,
  };
  const rpc = (fn: string, args: unknown) =>
    fetch(`${baseUrl}/api/database/rpc/${fn}`, { method: 'POST', headers: systemHeaders, body: JSON.stringify(args) });

  const pendingRes = await rpc('get_pending_push_notifications', { p_limit: 200 });
  if (!pendingRes.ok) {
    return res.status(502).json({ error: 'Failed to read pending notifications', status: pendingRes.status });
  }
  const rows = (await pendingRes.json()) as PendingRow[];
  if (!rows.length) return res.status(200).json({ sent: 0, pruned: 0, marked: 0 });

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa);
  } catch (err: any) {
    return res.status(502).json({ error: 'FCM auth failed', detail: String(err?.message || err) });
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  let sent = 0;
  const pruned = new Set<string>();
  // A notification with no device token (user never registered one) has
  // nothing to send but must still be marked, or it gets re-selected by
  // get_pending_push_notifications on every future run forever.
  const toMark = new Set<string>();

  await Promise.all(rows.map(async (row) => {
    if (!row.token) { toMark.add(row.notification_id); return; }

    // FCM's `data` payload must be flat string->string — App.tsx's
    // pushActionRef reads eventId/userId/screen directly off this object.
    const data: Record<string, string> = {};
    if (row.push_data) {
      for (const [k, v] of Object.entries(row.push_data)) data[k] = String(v);
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: row.token,
          notification: { title: row.title, body: row.body || '' },
          data,
          android: { priority: 'high', notification: { sound: 'default' } },
        },
      }),
    });

    if (resp.ok) { sent++; toMark.add(row.notification_id); return; }

    if (resp.status === 404 || resp.status === 400) {
      const errJson = await resp.json().catch(() => null);
      const code = errJson?.error?.details?.[0]?.errorCode || errJson?.error?.status;
      if (code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') {
        // Permanently dead token — nothing will ever make this send
        // succeed, so mark it sent (there's no point retrying) and prune
        // the token so future notifications skip it entirely.
        pruned.add(row.token);
        toMark.add(row.notification_id);
        await rpc('prune_push_token', { p_token: row.token }).catch(() => {});
        return;
      }
    }
    // Any other failure (rate limit, transient 5xx) — deliberately NOT
    // added to toMark, so push_sent stays false and the next sweep retries
    // it. The notification itself still shows in the in-app bell either way.
  }));

  if (toMark.size > 0) {
    await rpc('mark_notifications_pushed', { p_ids: Array.from(toMark) }).catch(() => {});
  }

  return res.status(200).json({ sent, pruned: pruned.size, marked: toMark.size, total: rows.length });
}
