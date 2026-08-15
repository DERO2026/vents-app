import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';
import { callProjectAdminTableRpc } from '../_lib/projectAdminDb.js';

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Reconciliation fallback for withdrawal requests stuck in 'processing'.
//
// transfer.success/transfer.failed webhooks (api/webhook/paystack.ts) are
// the primary way a 'processing' request resolves — but a webhook can be
// missed, or Paystack's dashboard webhook URL can simply not be configured
// to point here, and there's no way for us to detect that happening. This
// endpoint actively polls Paystack for each processing request's real
// status and resolves it via the exact same complete_organizer_payout /
// fail_organizer_payout RPCs the webhook calls — one source of truth for
// what "completion" means, reached two different ways.
//
// Admin-authenticated only (not anon-callable): the list of in-flight
// payouts (amounts, organizer_ids, transfer_codes) is real financial data
// that shouldn't be readable with just the public anon key.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const secret = process.env.PAYSTACK_SECRET_KEY;
  const baseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!secret || !baseUrl || !anonKey) {
    return res.status(500).json({ error: 'Payout system not configured' });
  }

  // admin_list_processing_payouts is EXECUTE-granted to `authenticated`
  // (is_admin() checked internally) — forwards the caller's own session
  // token. complete_organizer_payout/fail_organizer_payout are
  // project_admin-only (no anon/authenticated/service_role grant, by
  // design — mirrors InsForge's admin-key boundary) and go through the
  // direct project_admin Postgres connection instead (see
  // api/_lib/projectAdminDb.ts and
  // supabase/migrations/0021_project_admin_login.sql for why a plain
  // service API key/JWT isn't an option on this project).
  const adminHeaders = { 'Content-Type': 'application/json', Authorization: authHeader, apikey: anonKey };

  try {
    // is_admin() is enforced inside this RPC — a non-admin caller gets a
    // clean rejection here, before we ever touch Paystack.
    const listRes = await fetch(`${baseUrl}/rest/v1/rpc/admin_list_processing_payouts`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    if (!listRes.ok) {
      const errJson = await listRes.json().catch(() => null);
      return res.status(listRes.status).json({ error: errJson?.message || 'Admin access required' });
    }
    const rows: any[] = await listRes.json();

    const results: any[] = [];
    for (const row of rows) {
      if (!row.transfer_code) {
        results.push({ request_id: row.request_id, outcome: 'skipped_no_transfer_code' });
        continue;
      }
      try {
        const transferRes = await fetch(`https://api.paystack.co/transfer/${row.transfer_code}`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        const transferJson = await transferRes.json();
        if (!transferRes.ok || !transferJson.data) {
          results.push({ request_id: row.request_id, outcome: 'paystack_lookup_failed', detail: transferJson.message });
          continue;
        }
        const pstStatus = transferJson.data.status; // 'success' | 'failed' | 'reversed' | 'pending' | 'otp' | ...
        if (pstStatus !== 'success' && pstStatus !== 'failed' && pstStatus !== 'reversed') {
          results.push({ request_id: row.request_id, outcome: 'still_pending_on_paystack', paystack_status: pstStatus });
          continue;
        }

        const rpcRows = pstStatus === 'success'
          ? await callProjectAdminTableRpc<any>('complete_organizer_payout', [row.transfer_code])
          : await callProjectAdminTableRpc<any>('fail_organizer_payout', [row.transfer_code, `Reconciled from Paystack status: ${pstStatus}`]);
        const rpcRow = rpcRows[0];

        if (rpcRow?.organizer_email && (rpcRow.status === 'completed' || rpcRow.status === 'failed')) {
          sendPayoutDecisionEmail({
            to: rpcRow.organizer_email,
            name: rpcRow.organizer_name || 'there',
            amountNaira: fmtNaira(Number(rpcRow.amount_kobo) || 0),
            decision: rpcRow.status,
            reason: rpcRow.status === 'failed' ? `Reconciled from Paystack status: ${pstStatus}` : undefined,
          }).catch(() => {});
        }

        results.push({ request_id: row.request_id, outcome: rpcRow?.status || 'resolved', paystack_status: pstStatus });
      } catch (err: any) {
        results.push({ request_id: row.request_id, outcome: 'error', detail: err?.message });
      }
    }

    return res.status(200).json({ checked: rows.length, results });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Reconciliation failed' });
  }
}
