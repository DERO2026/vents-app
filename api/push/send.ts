import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { applyCors } from '../_lib/cors.js';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';
import { deliverPendingPushesForUser } from '../_lib/pushDelivery.js';

// ─── Native push send (Firebase Cloud Messaging HTTP v1) ─────────────────────
// Two request shapes, sharing this file to stay under the Hobby plan's
// 12-serverless-function cap:
//
// 1. { deliverForUserId } -- the event-driven delivery trigger. Called
//    immediately after a client action that just created a notification for
//    ANOTHER user (e.g. initiating/declining a ticket transfer, an admin
//    approving a service-provider request) so that recipient's push arrives
//    within seconds instead of waiting for the next daily cron sweep. Any
//    authenticated caller may use this mode (checked via
//    verifyInsforgeSession, no admin requirement) -- it is safe precisely
//    because the caller supplies only a user id, never message content: the
//    handler only ever looks up and delivers that user's own pre-existing,
//    already-legitimate unsent `notifications` rows (via the trusted
//    project_admin connection, see api/_lib/pushDelivery.ts), and device
//    tokens never leave this server process. Worst case of misuse is
//    accelerating a delivery that was already going to happen on its own.
//
// 2. { userId, title, body, data } -- the original admin/broadcast
//    capability, unchanged: caller must resolve to a Super Admin (via
//    admin_list_push_tokens, which itself enforces is_super_admin()), and
//    composes arbitrary content, so it stays admin-gated.
//
// Delivery requires a Firebase service account, provided as the env var
// FCM_SERVICE_ACCOUNT_JSON (the full service-account JSON, minified). Without
// it the endpoint returns 503 (mode 2) / a soft no-op (mode 1) — the client
// registration + token storage still work; only the send leg is gated on
// that credential.
//
// FCM v1 needs a short-lived OAuth2 access token minted from the service
// account (RS256-signed JWT → Google token endpoint). Implemented here with
// Node crypto so no extra dependency is pulled in.

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const session = await verifyInsforgeSession(authHeader);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // Mode 1: on-demand delivery trigger for one user's already-pending
  // notifications. Any authenticated caller -- see the file header comment
  // for why that's safe.
  const { deliverForUserId } = (req.body || {}) as { deliverForUserId?: string };
  if (deliverForUserId) {
    const result = await deliverPendingPushesForUser(deliverForUserId);
    return res.status(200).json(result);
  }

  // Mode 2: admin/broadcast -- unchanged below.
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const saJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!baseUrl || !anonKey) return res.status(500).json({ error: 'Backend not configured' });
  if (!saJson) return res.status(503).json({ error: 'Push not configured (FCM_SERVICE_ACCOUNT_JSON missing)' });

  let sa: { project_id: string; client_email: string; private_key: string };
  try {
    sa = JSON.parse(saJson);
  } catch {
    return res.status(500).json({ error: 'FCM_SERVICE_ACCOUNT_JSON is not valid JSON' });
  }

  const { userId, title, body, data } = (req.body || {}) as {
    userId?: string; title?: string; body?: string; data?: Record<string, string>;
  };
  if (!userId || !title) return res.status(400).json({ error: 'userId and title are required' });

  const rpc = (fn: string, args: unknown, useCallerToken = false) =>
    fetch(`${baseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: useCallerToken ? (authHeader as string) : `Bearer ${anonKey}`,
      },
      body: JSON.stringify(args),
    });

  // Read target tokens with the caller's (super-admin) token — the RPC enforces
  // is_super_admin(), so a non-admin session can't reach anyone's tokens.
  const tokensRes = await rpc('admin_list_push_tokens', { p_user_id: userId }, true);
  if (tokensRes.status === 403) return res.status(403).json({ error: 'Super Admin access required' });
  if (!tokensRes.ok) return res.status(502).json({ error: 'Failed to read device tokens' });
  const rows = (await tokensRes.json()) as { token: string; platform: string }[];
  if (!rows.length) return res.status(200).json({ sent: 0, note: 'No registered devices for user' });

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa);
  } catch (err: any) {
    return res.status(502).json({ error: 'FCM auth failed', detail: String(err?.message || err) });
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  let sent = 0;
  const pruned: string[] = [];

  await Promise.all(rows.map(async ({ token }) => {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body: body || '' },
          data: data || {},
          android: { priority: 'high', notification: { sound: 'default' } },
        },
      }),
    });
    if (resp.ok) { sent++; return; }
    // A permanently-invalid token → prune so we stop trying it.
    if (resp.status === 404 || resp.status === 400) {
      const errJson = await resp.json().catch(() => null);
      const code = errJson?.error?.details?.[0]?.errorCode || errJson?.error?.status;
      if (code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') {
        pruned.push(token);
        await rpc('admin_prune_push_token', { p_token: token }, true).catch(() => {});
      }
    }
  }));

  return res.status(200).json({ sent, total: rows.length, pruned: pruned.length });
}
