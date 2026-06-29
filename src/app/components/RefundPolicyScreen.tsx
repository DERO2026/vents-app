import { useEffect } from 'react';

export function RefundPolicyScreen() {
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')].filter(Boolean) as HTMLElement[];
    const prev = els.map(el => ({ overflow: el.style.overflow, position: el.style.position, inset: el.style.inset, height: el.style.height }));
    els.forEach(el => { el.style.overflow = 'auto'; el.style.position = 'static'; el.style.inset = ''; el.style.height = 'auto'; });
    return () => {
      els.forEach((el, i) => { el.style.overflow = prev[i].overflow; el.style.position = prev[i].position; el.style.inset = prev[i].inset; el.style.height = prev[i].height; });
    };
  }, []);

  return (
    <div style={{ background: '#07080F', minHeight: '100vh', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', padding: '40px 20px 80px', maxWidth: '680px', margin: '0 auto', lineHeight: 1.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <a href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontWeight: 900, fontSize: '18px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
          </div>
          <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
        </a>
      </div>

      <h1 style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '6px' }}>Refund Policy</h1>
      <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '32px' }}>Last updated: June 2026 · Effective: June 2026</p>

      <Section title="1. Our Refund Commitment">
        Vents is committed to ensuring a fair experience for both attendees and organizers. This policy explains when and how refunds are issued for ticket purchases made on the Vents platform.
      </Section>

      <Section title="2. Eligible Refunds — Attendees">
        You are eligible for a full refund in the following situations:<br /><br />
        • You request a refund <b style={{ color: '#F0F0FF' }}>within 48 hours of purchase</b> AND at least 24 hours before the event start time<br />
        • The event is <b style={{ color: '#F0F0FF' }}>cancelled by the organizer</b><br />
        • The event is <b style={{ color: '#F0F0FF' }}>significantly different</b> from what was advertised (different date, venue, or headliner)<br />
        • A <b style={{ color: '#F0F0FF' }}>technical error</b> resulted in duplicate ticket purchases
      </Section>

      <Section title="3. How to Request a Refund">
        Email <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a> with the following information:<br /><br />
        • Your full name and the email address used to purchase<br />
        • The event name and date<br />
        • Your ticket reference number (found in the app under My Tickets)<br />
        • Reason for your refund request<br /><br />
        We will respond within 24 hours. Approved refunds are processed within 5–7 business days back to your original payment method.
      </Section>

      <Section title="4. Non-Refundable Situations">
        Refunds will not be issued if:<br /><br />
        • The refund request is made <b style={{ color: '#F0F0FF' }}>less than 24 hours before the event</b><br />
        • The event has <b style={{ color: '#F0F0FF' }}>already taken place</b><br />
        • The ticket was <b style={{ color: '#F0F0FF' }}>used to gain entry</b> to the event<br />
        • You simply changed your mind more than 48 hours after purchase<br />
        • The request does not meet the conditions in Section 2
      </Section>

      <Section title="5. Cancelled Events">
        If an organizer cancels their event all ticket holders will receive an automatic full refund within 5–7 business days. You will be notified by email and in-app notification as soon as the cancellation is confirmed. No action is required from you — the refund is processed automatically.
      </Section>

      <Section title="6. Organizer Responsibilities">
        Organizers who cancel events are responsible for all associated refund costs including Paystack processing fees where applicable. Organizers with repeated cancellations may have their accounts suspended and may be required to pre-fund future events.
      </Section>

      <Section title="7. Disputes">
        If you believe a refund was incorrectly denied, email <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a> with "Refund Dispute" in the subject line. We will review all disputes within 48 hours and communicate our decision. Our decision on disputes is final.
      </Section>

      <Section title="8. Paystack Refund Processing">
        All refunds are processed through Paystack back to the original payment method (debit card or bank account used at checkout). Processing times depend on your bank and card issuer and typically take 5–7 business days after Vents approves the refund. Vents is not responsible for delays caused by your bank or card issuer.
      </Section>

      <Section title="9. Platform Fees">
        Vents' 5% platform fee charged to organizers is non-refundable in cases where the refund is not due to a Vents technical error. In cases of event cancellation by the organizer, the full ticket amount paid by the attendee is refunded.
      </Section>

      <Section title="10. Contact">
        Vents App Ltd<br />
        Gwarimpa, Abuja, Nigeria<br />
        Email: <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a><br />
        WhatsApp: <a href="https://wa.me/2349030737368" style={{ color: '#A78BFA' }}>+234 9030 737 368</a>
      </Section>

      <div style={{ marginTop: '40px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <a href="/privacy" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Privacy Policy</a>
        <a href="/terms" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Terms of Service</a>
        <a href="/" style={{ color: '#8B8FA8', fontSize: '13px', textDecoration: 'none' }}>← Back to Vents</a>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <h2 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, marginBottom: '10px', fontFamily: 'Space Grotesk, sans-serif' }}>{title}</h2>
      <p style={{ margin: 0, fontSize: '14px' }}>{children}</p>
    </div>
  );
}
