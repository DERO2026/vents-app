import { useEffect } from 'react';

export function TermsScreen() {
  useEffect(() => {
    const els = [document.documentElement, document.body, document.getElementById('root')].filter(Boolean) as HTMLElement[];
    const prev = els.map(el => ({ overflow: el.style.overflow, position: el.style.position, inset: el.style.inset, height: el.style.height }));
    els.forEach(el => { el.style.overflow = 'auto'; el.style.position = 'static'; el.style.inset = ''; el.style.height = 'auto'; });
    return () => {
      els.forEach((el, i) => { el.style.overflow = prev[i].overflow; el.style.position = prev[i].position; el.style.inset = prev[i].inset; el.style.height = prev[i].height; });
    };
  }, []);

  return (
    <div style={{ background: '#090514', minHeight: '100dvh', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', padding: 'calc(40px + env(safe-area-inset-top)) 20px calc(80px + env(safe-area-inset-bottom))', maxWidth: '680px', margin: '0 auto', lineHeight: 1.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <a href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontWeight: 900, fontSize: '18px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
          </div>
          <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
        </a>
      </div>

      <h1 style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '6px' }}>Terms of Service</h1>
      <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '32px' }}>Last updated: June 2026 · Effective: June 2026</p>

      <Section title="1. Acceptance of Terms">
        By creating an account or using the Vents mobile application or website ("Service") you agree to these Terms of Service. If you do not agree, do not use the platform. You must be at least 13 years old to create an account. If you are between 13 and 18 years old you may only use the Service with parental or guardian consent.
      </Section>

      <Section title="2. About Vents">
        Vents is an event discovery and ticketing platform operated by Vents App Ltd, a company registered in Gwarimpa, Abuja, Nigeria. We connect event organizers with attendees across Nigeria. Vents is a marketplace — we are not the organizer of any event listed on the platform unless explicitly stated.
      </Section>

      <Section title="3. User Accounts">
        • You must be at least 13 years old to create an account<br />
        • You must provide accurate and truthful information when registering<br />
        • You are responsible for keeping your account credentials secure<br />
        • One person may not create multiple accounts<br />
        • You may not create an account if you have been permanently banned from the Service<br />
        • We reserve the right to suspend or terminate accounts that violate these Terms
      </Section>

      <Section title="4. Attendee Terms">
        • Tickets purchased are subject to the organizer's event terms and entry requirements<br />
        • Vents charges no additional fees to attendees beyond the displayed ticket price<br />
        • Ticket QR codes are for single use only and may not be duplicated or resold<br />
        • Vents Cents loyalty points have no cash value and cannot be withdrawn or converted to currency<br />
        • See our <a href="/refunds" style={{ color: '#A78BFA' }}>Refund Policy</a> for information on cancellations and refunds
      </Section>

      <Section title="5. Organizer Terms">
        • Organizers must provide accurate event information including date, venue, capacity, and description<br />
        • Organizers are responsible for delivering the event as advertised<br />
        • Vents charges a 5% platform fee on all paid ticket sales, deducted before payout<br />
        • Organizer payouts are processed within 1–3 business days after the event concludes<br />
        • Organizers must comply with all applicable Nigerian laws, regulations, and venue requirements<br />
        • Organizers must clearly state their refund policy on their event listing<br />
        • Vents reserves the right to remove events that violate our policies or receive significant complaints<br />
        • Organizers who cancel events are responsible for all associated refund costs
      </Section>

      <Section title="6. Payments">
        • All payments are processed securely by Paystack Technology Limited<br />
        • Prices are displayed in Nigerian Naira (NGN)<br />
        • Vents does not store payment card information — all card data goes directly to Paystack<br />
        • Failed payments will not result in ticket issuance<br />
        • Paystack's terms are available at <a href="https://paystack.com/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#A78BFA' }}>paystack.com/terms</a>
      </Section>

      <Section title="7. Refunds and Cancellations">
        See our full <a href="/refunds" style={{ color: '#A78BFA' }}>Refund Policy at getvents.com/refunds</a> for complete details on when refunds are available and how to request one.
      </Section>

      <Section title="8. Vents Cents">
        Vents Cents are in-app reward points awarded at our discretion. They:<br /><br />
        • Are <b style={{ color: '#F0F0FF' }}>not real money</b> and have no cash value<br />
        • Cannot be withdrawn, transferred, or converted to any currency<br />
        • May only be used for in-app discounts on ticket purchases<br />
        • May expire or be adjusted at any time at Vents' discretion<br />
        • Are not transferable between accounts
      </Section>

      <Section title="9. Prohibited Conduct">
        You may not:<br /><br />
        • Post false, misleading, or fraudulent event information<br />
        • Use the platform for illegal activities<br />
        • Attempt to bypass or circumvent security measures<br />
        • Harass, threaten, or impersonate other users<br />
        • Create fake accounts or use automated tools to access the platform<br />
        • Resell tickets at inflated prices (scalping) without written permission from Vents<br />
        • Post or distribute content that is unlawful, defamatory, obscene, or that infringes third-party rights
      </Section>

      <Section title="10. Intellectual Property">
        The Vents name, logo, and platform are owned by Vents App Ltd and may not be used without written permission. User-generated content (event listings, profile photos, reviews) remains owned by the user. By posting content you grant Vents a non-exclusive, royalty-free license to display and distribute that content in connection with the Service.
      </Section>

      <Section title="11. Limitation of Liability">
        Vents is a platform connecting organizers and attendees. We are not responsible for the quality, safety, or delivery of events organized by third parties. The Service is provided "as is" without warranties of any kind. Our total liability for any claim arising from your use of the Service is limited to the amount you paid Vents in the 12 months preceding the claim.
      </Section>

      <Section title="12. Account Suspension">
        Vents may suspend or permanently ban accounts that violate these Terms. Banned users may not create new accounts. To appeal a ban, email <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a>.
      </Section>

      <Section title="13. Changes to These Terms">
        We may update these Terms at any time. Material changes will be notified via email or in-app notification at least 7 days before they take effect. Continued use after that date constitutes acceptance of the updated Terms.
      </Section>

      <Section title="14. Governing Law">
        These Terms are governed by the laws of the Federal Republic of Nigeria. Disputes shall be subject to the exclusive jurisdiction of Nigerian courts.
      </Section>

      <Section title="15. Contact">
        Vents App Ltd<br />
        Gwarimpa, Abuja, Nigeria<br />
        Email: <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a><br />
        WhatsApp: <a href="https://wa.me/2349030737368" style={{ color: '#A78BFA' }}>+234 9030 737 368</a>
      </Section>

      <div style={{ marginTop: '40px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <a href="/privacy" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Privacy Policy</a>
        <a href="/refunds" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Refund Policy</a>
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
