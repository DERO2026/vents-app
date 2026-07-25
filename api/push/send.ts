import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import { applyCors } from '../_lib/cors.js';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';

// ─── Native push send (Firebase Cloud Messaging HTTP v1) ─────────────────────
// Sends a notification to every device token registered for a target user.
//
// Auth: caller must present a valid InsForge session that resolves to a Super
// Admin (checked via whoami_admin). Sends are an admin/broadcast capability.
//
// Delivery requires a Firebase service account, provided as the env var
// FCM_SERVICE_ACCOUNT_JSON (the full service-account JSON, minified). Without
// it the endpoint returns 503 — the client registration + token storage still
// work; only the send leg is gated on that credential.
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

  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
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
    fetch(`${baseUrl}/api/database/rpc/${fn}`, {
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
