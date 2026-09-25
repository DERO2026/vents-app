// Shared FCM v1 delivery logic for exactly one user's currently-pending
// notifications -- extracted so both api/push/send.ts's new on-demand relay
// mode and api/webhook/paystack.ts (right after confirm_transfer_fee_payment)
// can trigger an immediate, targeted send without duplicating the JWT
// signing / fetch loop that api/cron/run.ts's bulk daily sweep also uses
// (kept separate there deliberately -- see that file's header comment).
//
// Reads/writes exclusively via the trusted project_admin Postgres
// connection (api/_lib/projectAdminDb.ts) -- never via a client-callable
// RPC -- so a device token is never exposed to anything but this server
// process. Safe to call multiple times for the same user (e.g. a webhook
// retry, or both the client-triggered call and this one racing): it only
// ever sends rows still marked push_sent = false and immediately marks
// whatever it sends, so a retry naturally finds nothing left to do.
import crypto from 'node:crypto';
import { callProjectAdminRpc, callProjectAdminTableRpc } from './projectAdminDb.js';

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getFcmAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
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
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
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

export interface DeliveryResult { sent: number; total: number }

/** Delivers whatever is currently unsent for one user. Never throws -- a
 * missing FCM credential, a transient FCM error, or a project_admin DB hiccup
 * all resolve to a soft {sent:0,total:0}/partial result so a caller using
 * this as a fire-and-forget best-effort accelerator never has to handle an
 * exception; the daily cron sweep still catches whatever this misses. */
export async function deliverPendingPushesForUser(userId: string, limit = 20): Promise<DeliveryResult> {
  try {
    const saJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!saJson) return { sent: 0, total: 0 };
    let sa: { project_id: string; client_email: string; private_key: string };
    try {
      sa = JSON.parse(saJson);
    } catch {
      return { sent: 0, total: 0 };
    }

    const rows = await callProjectAdminTableRpc<PendingRow>('get_pending_push_notifications_for_user', [userId, limit]);
    if (!rows.length) return { sent: 0, total: 0 };

    const accessToken = await getFcmAccessToken(sa);
    const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

    let sent = 0;
    const toMark = new Set<string>();

    await Promise.all(rows.map(async (row) => {
      if (!row.token) { toMark.add(row.notification_id); return; }

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
          toMark.add(row.notification_id);
          await callProjectAdminRpc('prune_push_token', [row.token]).catch(() => {});
        }
      }
      // Any other failure: leave push_sent false -- the daily cron sweep
      // will retry it later, same as it always has.
    }));

    if (toMark.size > 0) {
      await callProjectAdminRpc('mark_notifications_pushed', [Array.from(toMark)]).catch(() => {});
    }

    return { sent, total: rows.length };
  } catch (err) {
    console.error('[pushDelivery] deliverPendingPushesForUser failed (non-fatal, cron sweep will retry):', (err as any)?.message || err);
    return { sent: 0, total: 0 };
  }
}
