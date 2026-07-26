// Transactional email dispatcher, wrapping Resend's REST API directly (no SDK
// dependency needed — Resend's HTTP API is a single POST /emails call).
// RESEND_API_KEY must be a server-only Vercel env var (no VITE_ prefix) —
// Vite inlines VITE_-prefixed vars into the client bundle, which would leak
// the secret key publicly.

const FROM = 'Vents <support@getvents.com>';

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[mailer] RESEND_API_KEY not set — skipping email:', subject, 'to', to);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[mailer] Resend send failed', res.status, err);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[mailer] Resend request error:', err?.message || err);
    return false;
  }
}

function wrapTemplate(title: string, bodyHtml: string): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #020005; padding: 32px 16px; color: #F0F0FF;">
    <div style="max-width: 480px; margin: 0 auto; background: #090514; border-radius: 20px; overflow: hidden; border: 1px solid rgba(255,255,255,0.08);">
      <div style="background: linear-gradient(135deg, #7B2FBE, #4F46E5); padding: 28px 24px;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #fff;">Vents</h1>
      </div>
      <div style="padding: 28px 24px;">
        <h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #F0F0FF;">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="padding: 16px 24px; border-top: 1px solid rgba(255,255,255,0.06);">
        <p style="margin: 0; font-size: 12px; color: #8B8FA8;">Vents · Lagos, Nigeria · <a href="https://getvents.com" style="color: #A855F7;">getvents.com</a></p>
      </div>
    </div>
  </div>`;
}

export async function sendOrganizerRequestDecisionEmail(params: {
  to: string;
  name: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}): Promise<boolean> {
  const { to, name, decision, reason } = params;
  if (decision === 'approved') {
    return sendEmail(
      to,
      "You're now a Vents Organizer 🎉",
      wrapTemplate("You're approved!", `
        <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
        <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Your request to become a Vents organizer has been approved. You can now create and manage events, sell tickets, and access your organizer dashboard.</p>
        <a href="https://getvents.com" style="display: inline-block; margin-top: 12px; background: linear-gradient(135deg,#7C3AED,#A855F7); color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 700; font-size: 14px;">Open Vents</a>
      `)
    );
  }
  return sendEmail(
    to,
    'Update on your organizer request',
    wrapTemplate('Request not approved', `
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Your request to become a Vents organizer wasn't approved this time.</p>
      ${reason ? `<p style="color: #C4C9E0; font-size: 14px; line-height: 1.6; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25); border-radius: 10px; padding: 12px 14px;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
      <p style="color: #8B8FA8; font-size: 13px; line-height: 1.6;">You're welcome to submit a new request once you've addressed the feedback above.</p>
    `)
  );
}

export async function sendOrganizerVerificationDecisionEmail(params: {
  to: string;
  name: string;
  companyName: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}): Promise<boolean> {
  const { to, name, companyName, decision, reason } = params;
  if (decision === 'approved') {
    return sendEmail(
      to,
      'Your brand is now verified on Vents ✅',
      wrapTemplate('Brand verified!', `
        <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
        <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">${escapeHtml(companyName)} has been verified on Vents. A verified badge now appears next to your organizer profile, helping attendees trust your events.</p>
        <a href="https://getvents.com" style="display: inline-block; margin-top: 12px; background: linear-gradient(135deg,#7C3AED,#A855F7); color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 700; font-size: 14px;">Open Vents</a>
      `)
    );
  }
  return sendEmail(
    to,
    'Update on your brand verification request',
    wrapTemplate('Verification not approved', `
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Your brand verification request for ${escapeHtml(companyName)} wasn't approved this time.</p>
      ${reason ? `<p style="color: #C4C9E0; font-size: 14px; line-height: 1.6; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25); border-radius: 10px; padding: 12px 14px;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
      <p style="color: #8B8FA8; font-size: 13px; line-height: 1.6;">You're welcome to submit a new request with updated documents.</p>
    `)
  );
}

export async function sendPayoutDecisionEmail(params: {
  to: string;
  name: string;
  amountNaira: string;
  decision: 'completed' | 'rejected' | 'failed';
  reason?: string;
}): Promise<boolean> {
  const { to, name, amountNaira, decision, reason } = params;
  if (decision === 'completed') {
    return sendEmail(
      to,
      `Your withdrawal of ${amountNaira} has been sent 💸`,
      wrapTemplate('Withdrawal sent', `
        <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
        <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Your withdrawal of <strong>${escapeHtml(amountNaira)}</strong> has been approved and sent to your bank account.</p>
        <a href="https://getvents.com" style="display: inline-block; margin-top: 12px; background: linear-gradient(135deg,#7C3AED,#A855F7); color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 700; font-size: 14px;">Open Vents</a>
      `)
    );
  }
  return sendEmail(
    to,
    `Update on your withdrawal of ${amountNaira}`,
    wrapTemplate(decision === 'rejected' ? 'Withdrawal rejected' : 'Withdrawal failed', `
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Your withdrawal request of <strong>${escapeHtml(amountNaira)}</strong> ${decision === 'rejected' ? 'was not approved' : 'could not be completed'}. The full amount has been returned to your available balance.</p>
      ${reason ? `<p style="color: #C4C9E0; font-size: 14px; line-height: 1.6; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25); border-radius: 10px; padding: 12px 14px;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
    `)
  );
}

export async function sendTicketRefundEmail(params: {
  to: string;
  name: string;
  eventTitle: string;
  ticketType: string;
  amountNaira: string;
  reason: string;
}): Promise<boolean> {
  const { to, name, eventTitle, ticketType, amountNaira, reason } = params;
  return sendEmail(
    to,
    `Your ticket for ${eventTitle} has been refunded`,
    wrapTemplate('Ticket refunded', `
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Hi ${escapeHtml(name)},</p>
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6;">Your <strong>${escapeHtml(ticketType)}</strong> ticket for <strong>${escapeHtml(eventTitle)}</strong> has been refunded. ${amountNaira} will be returned to your original payment method — this can take a few business days to reflect, depending on your bank.</p>
      <p style="color: #C4C9E0; font-size: 14px; line-height: 1.6; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25); border-radius: 10px; padding: 12px 14px;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
    `)
  );
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
