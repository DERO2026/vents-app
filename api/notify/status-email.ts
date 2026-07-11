import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendOrganizerRequestDecisionEmail, sendOrganizerVerificationDecisionEmail, sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Fires the approval/rejection email for an organizer-role request or a CAC
// brand-verification request. Called by the admin client right after the
// status-changing RPC succeeds — never blocks the admin action if it fails.
//
// Admin-ness is verified the same way every other admin endpoint in this
// app does it: forward the caller's own InsForge token and let RLS decide.
// admin-only SELECT policies on both tables mean a non-admin caller simply
// gets an empty result back, not the row.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const { request_type, request_id, decision, reason } = req.body || {};
  if (!['organizer', 'cac', 'payout'].includes(request_type)) {
    return res.status(400).json({ error: 'request_type must be "organizer", "cac", or "payout"' });
  }
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!['approved', 'rejected', 'completed', 'failed'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision' });
  }

  const baseUrl = process.env.VITE_INSFORGE_URL;
  const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) return res.status(500).json({ error: 'Not configured' });

  const insforgeHeaders = { Authorization: authHeader, apikey: anonKey };

  try {
    const table = request_type === 'organizer' ? 'organizer_requests'
      : request_type === 'cac' ? 'organizer_verification_requests'
      : 'organizer_withdrawal_requests';
    const ownerCol = request_type === 'payout' ? 'organizer_id' : 'user_id';
    const extraSelect = request_type === 'cac' ? ',company_name' : request_type === 'payout' ? ',amount_kobo' : '';
    const reqRes = await fetch(
      `${baseUrl}/api/database/records/${table}?id=eq.${encodeURIComponent(request_id)}&select=${ownerCol}${extraSelect}`,
      { headers: insforgeHeaders }
    );
    if (!reqRes.ok) return res.status(reqRes.status).json({ error: 'Could not load request' });
    const reqRows = await reqRes.json();
    const reqRow = Array.isArray(reqRows) ? reqRows[0] : null;
    const ownerId = reqRow?.[ownerCol];
    if (!ownerId) return res.status(404).json({ error: 'Request not found' });

    const userRes = await fetch(
      `${baseUrl}/api/database/records/users?id=eq.${encodeURIComponent(ownerId)}&select=full_name,email`,
      { headers: insforgeHeaders }
    );
    if (!userRes.ok) return res.status(userRes.status).json({ error: 'Could not load user' });
    const userRows = await userRes.json();
    const user = Array.isArray(userRows) ? userRows[0] : null;
    if (!user?.email) return res.status(404).json({ error: 'User not found' });

    const sent = request_type === 'organizer'
      ? await sendOrganizerRequestDecisionEmail({
          to: user.email,
          name: user.full_name || 'there',
          decision: decision as 'approved' | 'rejected',
          reason: decision === 'rejected' ? reason : undefined,
        })
      : request_type === 'cac'
      ? await sendOrganizerVerificationDecisionEmail({
          to: user.email,
          name: user.full_name || 'there',
          companyName: reqRow.company_name || 'your organization',
          decision: decision as 'approved' | 'rejected',
          reason: decision === 'rejected' ? reason : undefined,
        })
      : await sendPayoutDecisionEmail({
          to: user.email,
          name: user.full_name || 'there',
          amountNaira: fmtNaira(Number(reqRow.amount_kobo) || 0),
          decision: decision as 'completed' | 'rejected' | 'failed',
          reason: decision !== 'completed' ? reason : undefined,
        });
    return res.status(200).json({ sent });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Notification failed' });
  }
}
