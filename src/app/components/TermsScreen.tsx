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
    <div style={{ background: '#07080F', minHeight: '100vh', color: '#C4C9E0', fontFamily: 'Inter, sans-serif', padding: '40px 20px 80px', maxWidth: '680px', margin: '0 auto', lineHeight: 1.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#fff', fontWeight: 900, fontSize: '18px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
        </div>
        <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '20px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
      </div>

      <h1 style={{ color: '#F0F0FF', fontSize: '28px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '6px' }}>Terms of Use</h1>
      <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '32px' }}>Last updated: 19 June 2026 · Effective: 19 June 2026</p>

      <Section title="1. Acceptance of Terms">
        By accessing or using the Vents mobile app or website ("Service"), you agree to these Terms of Use. You must be at least 13 years old to use Vents. If you are under 18, you may only use the Service with parental consent. By creating an account you confirm you meet the age requirement.
      </Section>

      <Section title="2. The Service">
        Vents is an event discovery and ticketing platform that allows organisers to create and sell tickets to events, and attendees to discover and purchase tickets. Vents is a marketplace; we are not the organiser of any event listed unless explicitly stated.
      </Section>

      <Section title="3. Accounts">
        You must provide accurate information when creating an account. You are responsible for all activity under your account. You may not create an account if you have been permanently banned from the Service. One person may hold only one account.
      </Section>

      <Section title="4. Organiser Responsibilities">
        Organisers who create events on Vents are solely responsible for:<br /><br />
        • The accuracy of event information (date, venue, lineup, capacity)<br />
        • Delivering the event as described<br />
        • Compliance with all applicable laws, venue regulations, and licensing requirements<br />
        • Refund policies (which must be clearly stated on the event listing)<br /><br />
        Vents reserves the right to remove events that violate these Terms or that receive significant complaints.
      </Section>

      <Section title="5. Ticket Purchases">
        All ticket sales are final unless the organiser explicitly states a refund policy. If an event is cancelled by the organiser, Vents will facilitate refunds through Paystack to the original payment method. Processing times are subject to Paystack's schedule (typically 5–10 business days).<br /><br />
        Vents charges a platform fee on each transaction. This fee is displayed at checkout and is non-refundable.
      </Section>

      <Section title="6. Vents Cents">
        Vents Cents are in-app reward points awarded at our discretion. They:<br /><br />
        • Are <b style={{ color: '#F0F0FF' }}>not real money</b> and have no cash value<br />
        • Cannot be withdrawn, transferred, or converted to any currency<br />
        • May be used only for in-app discounts on ticket purchases<br />
        • May expire or be adjusted at any time at Vents' discretion<br />
        • Are not transferable between accounts
      </Section>

      <Section title="7. Prohibited Conduct">
        You may not:<br /><br />
        • Post false, misleading, or fraudulent events<br />
        • Harass, threaten, or impersonate other users<br />
        • Resell tickets at inflated prices (scalping) without our written permission<br />
        • Use automated tools to scrape, crawl, or extract data<br />
        • Circumvent security measures or access systems you are not authorised to access<br />
        • Post or distribute content that is unlawful, defamatory, obscene, or that infringes third-party rights<br />
        • Use the Service if you are under 13 years old
      </Section>

      <Section title="8. 18+ Events">
        Certain events are marked as 18+ by organisers. By purchasing a ticket to an 18+ event, you confirm you are at least 18 years old. Vents does not verify ages; you are responsible for compliance with age restrictions at the venue.
      </Section>

      <Section title="9. Content and Intellectual Property">
        You retain ownership of content you post. By posting content, you grant Vents a non-exclusive, royalty-free licence to display, reproduce, and distribute that content in connection with the Service. You may not post content you do not own or have rights to. Vents' name, logo, and brand elements are our intellectual property and may not be used without written permission.
      </Section>

      <Section title="10. Account Suspension and Bans">
        Vents may suspend or permanently ban accounts that violate these Terms. Banned users may not create new accounts. To appeal a ban, contact us via WhatsApp at <a href="https://wa.me/2349030737368" style={{ color: '#A78BFA' }}>+234 9030 737 368</a> or email <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a>.
      </Section>

      <Section title="11. Reporting Content">
        You may report events or users that you believe violate these Terms using the Report button in the app. We review all reports and will take action where appropriate, including removing content or banning users.
      </Section>

      <Section title="12. Disclaimer of Warranties">
        The Service is provided "as is" without warranties of any kind. Vents does not guarantee the accuracy of event listings or the conduct of event organisers. To the fullest extent permitted by Nigerian law, we disclaim all express and implied warranties.
      </Section>

      <Section title="13. Limitation of Liability">
        To the fullest extent permitted by law, Vents' total liability for any claim arising from your use of the Service is limited to the amount you paid Vents in the 12 months preceding the claim. We are not liable for events cancelled, altered, or not delivered by organisers.
      </Section>

      <Section title="14. Changes to Terms">
        We may update these Terms at any time. Material changes will be notified via email or in-app notification at least 7 days before they take effect. Continued use after that date constitutes acceptance.
      </Section>

      <Section title="15. Governing Law">
        These Terms are governed by the laws of the Federal Republic of Nigeria. Disputes shall be subject to the exclusive jurisdiction of Nigerian courts.
      </Section>

      <Section title="16. Contact">
        Vents Ltd<br />
        Email: <a href="mailto:support@getvents.com" style={{ color: '#A78BFA' }}>support@getvents.com</a><br />
        WhatsApp: <a href="https://wa.me/2349030737368" style={{ color: '#A78BFA' }}>+234 9030 737 368</a>
      </Section>

      <div style={{ marginTop: '40px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '20px', display: 'flex', gap: '16px' }}>
        <a href="/privacy" style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none' }}>Privacy Policy</a>
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
