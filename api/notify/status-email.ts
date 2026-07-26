import type { VercelRequest, VercelResponse } from '@vercel/node';
import QRCode from 'qrcode';
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

// Real signed pass token — same generate_ticket_token() RPC the app itself
// uses (src/lib/ticketToken.ts), so the QR emailed to an attendee is a
// genuine, scanner-valid v2 signed token, not a placeholder. A couple of
// quick retries absorb transient network blips without failing the whole send.
async function mintTicketToken(ticketId: string, baseUrl: string, headers: Record<string, string>): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/database/rpc/generate_ticket_token`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_ticket_id: ticketId }),
      });
      if (res.ok) {
        const token = await res.json().catch(() => null);
        if (typeof token === 'string' && token) return token;
      }
      console.warn('[ticket-email] mint token failed', { ticketId, attempt, status: res.status });
    } catch (e) {
      console.warn('[ticket-email] mint token threw', { ticketId, attempt, e });
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return null;
}

// Render the signed token as a PNG QR and host it in the (public) `tickets`
// storage bucket so it can be embedded as a normal <img src> — the only email
// image approach that reliably renders across Gmail/Apple Mail/Outlook without
// relying on data-URI or attachment/cid support we can't verify from here.
// Best-effort: a failure here degrades to a text code in the email, it never
// blocks the send.
async function renderAndHostQr(token: string, ticketId: string, baseUrl: string, headers: Record<string, string>): Promise<string | null> {
  try {
    const png = await QRCode.toBuffer(token, { width: 480, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#0A0B14', light: '#ffffff' } });
    const fd = new FormData();
    fd.append('file', new File([png], `qr-${ticketId}-${Date.now()}.png`, { type: 'image/png' }));
    const res = await fetch(`${baseUrl}/api/storage/buckets/tickets/objects`, { method: 'POST', headers, body: fd });
    if (!res.ok) { console.warn('[ticket-email] QR upload failed', { ticketId, status: res.status }); return null; }
    const data = await res.json().catch(() => null);
    if (data?.url) return data.url as string;
    if (data?.key) return `${baseUrl}/api/storage/buckets/tickets/objects/${encodeURIComponent(data.key)}`;
    return null;
  } catch (e) {
    console.warn('[ticket-email] QR render/upload threw', { ticketId, e });
    return null;
  }
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
  // The buyer triggers this right after a group purchase. We authenticate
  // THEM, verify the tickets belong to their purchase, then send ONE email PER
  // UNIQUE ATTENDEE EMAIL — each containing only that attendee's own ticket(s)
  // with a real, scanner-valid signed QR — never all tickets bundled into the
  // buyer's inbox. Every detail (event, holder, ticket type, QR) is pulled
  // server-side from the DB; nothing here trusts client-supplied content.
  if ((req.body || {}).request_type === 'ticket') {
    const { event_id } = req.body || {};
    if (!event_id || typeof event_id !== 'string') return res.status(400).json({ error: 'event_id required' });
    if (!baseUrlEarly || !anonKeyEarly) return res.status(500).json({ error: 'Not configured' });

    const session = await verifyInsforgeSession(authHeader);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const h = { Authorization: authHeader, apikey: anonKeyEarly } as Record<string, string>;
    try {
      // The caller's own tickets for this event (RLS also restricts to owner —
      // only the buyer can trigger delivery, but each ticket is then routed to
      // the attendee email that was entered for IT at checkout).
      const tRes = await fetch(`${baseUrlEarly}/api/database/records/tickets?event_id=eq.${encodeURIComponent(event_id)}&user_id=eq.${encodeURIComponent(session.userId)}&select=id,ticket_type,holder_name,holder_email,created_at,status&order=created_at.desc&limit=20`, { headers: h });
      if (!tRes.ok) return res.status(tRes.status).json({ error: 'Could not load tickets' });
      const tickets = (await tRes.json().catch(() => [])) as any[];
      if (!Array.isArray(tickets) || tickets.length === 0) return res.status(404).json({ error: 'No tickets found' });

      // Group to just the latest purchase batch (within ~10 min of the newest).
      const newest = new Date(tickets[0].created_at).getTime();
      const batch = tickets.filter((t) => Math.abs(new Date(t.created_at).getTime() - newest) < 10 * 60 * 1000);

      const evRes = await fetch(`${baseUrlEarly}/api/database/records/events?id=eq.${encodeURIComponent(event_id)}&select=title,event_date,location`, { headers: h });
      const ev = (await evRes.json().catch(() => []))?.[0] || {};
      const dateStr = ev.event_date ? new Date(ev.event_date).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' }) : 'See app';

      // Group tickets by the UNIQUE email entered for each attendee — this is
      // the actual fix. Previously every ticket in the batch, regardless of
      // whose name/email was on it, was summarized into one email sent only to
      // the buyer. Falls back to the buyer's own session email only for a row
      // that (should never, but defensively) has no holder_email on file.
      const groups = new Map<string, any[]>();
      for (const t of batch) {
        const key = (t.holder_email || session.email || '').trim().toLowerCase();
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(t);
      }
      if (groups.size === 0) return res.status(400).json({ error: 'No attendee email on file' });

      let sentCount = 0;
      const results: Array<{ email: string; sent: boolean }> = [];

      for (const [attendeeEmail, myTickets] of groups) {
        // One real signed QR per ticket, hosted so it renders as a normal
        // inline image in any mail client (see renderAndHostQr). Best-effort
        // per ticket — a failed QR degrades that row to a text code instead of
        // failing the whole recipient's email.
        const blocks = await Promise.all(myTickets.map(async (t) => {
          const token = await mintTicketToken(t.id, baseUrlEarly, h);
          const qrUrl = token ? await renderAndHostQr(token, t.id, baseUrlEarly, h) : null;
          return { ticket: t, qrUrl };
        }));

        const isBuyer = attendeeEmail === (session.email || '').trim().toLowerCase();
        const ticketBlocksHtml = blocks.map(({ ticket: t, qrUrl }) => `
          <div style="border:1px solid #eee;border-radius:12px;padding:16px;margin-top:14px;text-align:center;">
            <p style="margin:0 0 2px;font-weight:700;font-size:14px;">${escapeHtml(t.holder_name || 'Guest')}</p>
            <p style="margin:0 0 12px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(t.ticket_type || 'General')}</p>
            ${qrUrl
              ? `<img src="${qrUrl}" alt="Ticket QR code" width="220" height="220" style="display:block;margin:0 auto;border-radius:8px;border:1px solid #eee;" />`
              : `<div style="padding:20px;background:#F7F7F9;border-radius:8px;color:#888;font-size:12px;">QR unavailable — open My Tickets in the app to view it.</div>`}
            <p style="margin:12px 0 0;font-family:monospace;font-size:13px;letter-spacing:0.03em;">${escapeHtml(ticketDisplayCode(t.id))}</p>
          </div>`).join('');

        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
            <div style="background:linear-gradient(135deg,#7B2FBE,#4F46E5);padding:24px;border-radius:14px 14px 0 0;color:#fff;">
              <div style="font-size:13px;letter-spacing:1px;opacity:.85;">VENTS · TICKET CONFIRMED</div>
              <div style="font-size:22px;font-weight:800;margin-top:6px;">${escapeHtml(ev.title || 'Your event')}</div>
            </div>
            <div style="border:1px solid #eee;border-top:none;border-radius:0 0 14px 14px;padding:20px;">
              <p style="margin:0 0 4px;"><strong>📅 ${escapeHtml(dateStr)}</strong></p>
              <p style="margin:0 0 16px;color:#555;">📍 ${escapeHtml(ev.location || 'See app for venue')}</p>
              <p style="margin:0 0 4px;font-weight:700;">${isBuyer && blocks.length !== batch.length ? `Your ${blocks.length} ticket${blocks.length > 1 ? 's' : ''}` : `Your ticket${blocks.length > 1 ? 's' : ''}`}:</p>
              ${ticketBlocksHtml}
              <div style="margin-top:18px;padding:14px;background:#F5F1FF;border-radius:10px;font-size:13px;color:#4B2E83;">
                <strong>Entry &amp; validation:</strong> Present this QR code at the door, or open the Vents app → <em>My Tickets</em>. Each QR is signed and single-use — screenshots that don't match will be declined.
              </div>
            </div>
          </div>`;

        const sent = await sendTicketEmailResend(attendeeEmail, `🎟️ Your ticket${blocks.length > 1 ? 's' : ''} for ${ev.title || 'your event'}`, html);
        if (sent) sentCount++;
        results.push({ email: attendeeEmail, sent });
      }

      return res.status(200).json({ sent: sentCount > 0, recipients: results.length, delivered: sentCount, results });
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
