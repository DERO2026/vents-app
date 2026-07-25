import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendOrganizerRequestDecisionEmail, sendOrganizerVerificationDecisionEmail, sendPayoutDecisionEmail } from '../_lib/mailer.js';
import { applyCors } from '../_lib/cors.js';
import { verifyInsforgeSession } from '../_lib/verifyAuth.js';

function fmtNaira(kobo: number): string {
  return '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Friendly ticket code — same deterministic derivation as src/lib/ticketCode.ts
// so the email matches what the app shows on the pass.
function ticketDisplayCode(ticketId: string): string {
  const hex = (ticketId || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 8) return (ticketId || '').toUpperCase();
  let n: bigint;
  try { n = BigInt('0x' + hex); } catch { return ticketId.toUpperCase(); }
  const out = n.toString(36).toUpperCase().padStart(25, '0');
  return 'VT-' + (out.match(/.{1,5}/g) || [out]).join('-');
}

const escapeHtml = (s: string) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// Self-contained Resend send (mirrors _lib/mailer.ts's config) so this
// non-admin, self-serve ticket path doesn't depend on that module.
async function sendTicketEmailResend(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[ticket-email] RESEND_API_KEY not set — skipping'); return false; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Vents <support@getvents.com>', to: [to], subject, html }),
    });
    return res.ok;
  } catch { return false; }
}

// Fires the approval/rejection email for an organizer-role request or a CAC
// brand-verification request. Called by the admin client right after the
// status-changing RPC succeeds — never blocks the admin action if it fails.
//
// Admin-ness is verified with a real server-side check (the is_admin() RPC,
// forwarded with the caller's own token) rather than relying on RLS to fail
// closed — organizer_requests/organizer_verification_requests/
// organizer_withdrawal_requests all have an "OR own-user" SELECT policy
// alongside the admin one, so a non-admin owner could otherwise read their
// own request row here and trigger a fake "approved"/"completed" decision
// email to themselves with any decision value they chose.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });

  const baseUrlEarly = process.env.VITE_INSFORGE_URL;
  const anonKeyEarly = process.env.VITE_INSFORGE_ANON_KEY;

  // ── Self-serve ticket confirmation (non-admin) ─────────────────────────────
  // A buyer confirms their OWN purchase. We authenticate them, verify they
  // actually own tickets for the event, then email ONLY their own address with
  // real details pulled from the DB (never trusting client-supplied content).
  if ((req.body || {}).request_type === 'ticket') {
    const { event_id } = req.body || {};
    if (!event_id || typeof event_id !== 'string') return res.status(400).json({ error: 'event_id required' });
    if (!baseUrlEarly || !anonKeyEarly) return res.status(500).json({ error: 'Not configured' });

    const session = await verifyInsforgeSession(authHeader);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const h = { Authorization: authHeader, apikey: anonKeyEarly } as Record<string, string>;
    try {
      // The caller's own tickets for this event (RLS also restricts to owner).
      const tRes = await fetch(`${baseUrlEarly}/api/database/records/tickets?event_id=eq.${encodeURIComponent(event_id)}&user_id=eq.${encodeURIComponent(session.userId)}&select=id,ticket_type,holder_name,holder_email,created_at,status&order=created_at.desc&limit=20`, { headers: h });
      if (!tRes.ok) return res.status(tRes.status).json({ error: 'Could not load tickets' });
      const tickets = (await tRes.json().catch(() => [])) as any[];
      if (!Array.isArray(tickets) || tickets.length === 0) return res.status(404).json({ error: 'No tickets found' });

      // Group to just the latest purchase batch (within ~10 min of the newest).
      const newest = new Date(tickets[0].created_at).getTime();
      const batch = tickets.filter((t) => Math.abs(new Date(t.created_at).getTime() - newest) < 10 * 60 * 1000);

      const evRes = await fetch(`${baseUrlEarly}/api/database/records/events?id=eq.${encodeURIComponent(event_id)}&select=title,event_date,location`, { headers: h });
      const ev = (await evRes.json().catch(() => []))?.[0] || {};
      const toEmail = session.email || batch[0].holder_email;
      if (!toEmail) return res.status(400).json({ error: 'No email on file' });

      const dateStr = ev.event_date ? new Date(ev.event_date).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' }) : 'See app';
      const rows = batch.map((t) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;">${escapeHtml(t.holder_name || 'Guest')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;">${escapeHtml(t.ticket_type || 'General')}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(ticketDisplayCode(t.id))}</td>
        </tr>`).join('');
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
          <div style="background:linear-gradient(135deg,#7B2FBE,#4F46E5);padding:24px;border-radius:14px 14px 0 0;color:#fff;">
            <div style="font-size:13px;letter-spacing:1px;opacity:.85;">VENTS · TICKET CONFIRMED</div>
            <div style="font-size:22px;font-weight:800;margin-top:6px;">${escapeHtml(ev.title || 'Your event')}</div>
          </div>
          <div style="border:1px solid #eee;border-top:none;border-radius:0 0 14px 14px;padding:20px;">
            <p style="margin:0 0 4px;"><strong>📅 ${escapeHtml(dateStr)}</strong></p>
            <p style="margin:0 0 16px;color:#555;">📍 ${escapeHtml(ev.location || 'See app for venue')}</p>
            <p style="margin:0 0 8px;font-weight:700;">Your ${batch.length} ticket${batch.length > 1 ? 's' : ''}:</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead><tr>
                <th style="text-align:left;padding:8px 12px;color:#888;font-size:11px;text-transform:uppercase;">Attendee</th>
                <th style="text-align:left;padding:8px 12px;color:#888;font-size:11px;text-transform:uppercase;">Type</th>
                <th style="text-align:left;padding:8px 12px;color:#888;font-size:11px;text-transform:uppercase;">Code</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <div style="margin-top:18px;padding:14px;background:#F5F1FF;border-radius:10px;font-size:13px;color:#4B2E83;">
              <strong>Entry & validation:</strong> Open the Vents app → <em>My Tickets</em> and present the QR code at the door. Each QR is signed and single-use — screenshots that don't match will be declined.
            </div>
          </div>
        </div>`;

      const sent = await sendTicketEmailResend(toEmail, `🎟️ Your tickets for ${ev.title || 'your event'}`, html);
      return res.status(200).json({ sent });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Ticket email failed' });
    }
  }

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
    const adminCheckRes = await fetch(`${baseUrl}/api/database/rpc/is_admin`, {
      method: 'POST',
      headers: { ...insforgeHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const isAdmin = adminCheckRes.ok && (await adminCheckRes.json().catch(() => false)) === true;
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

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
